"use strict";

const fs = require('fs');
const {promisify} = require('bluebird');
const {EventBus} = require('../utils/event_bus');
const {File} = require('./file');
const {validateFileSystemDependencies} = require('./dependencies');

class FileSystemCache {
  constructor(fileSystem={}) {
    this.fileSystem = {
      readFile: fileSystem.readFile || promisify(fs.readFile),
      stat: fileSystem.stat || promisify(fs.stat)
    };
    this.files = Object.create(null);
    this.trapsByFile = Object.create(null);

    // Incoming data
    this.fileAdded = new EventBus();
    this.fileChanged = new EventBus();
    this.fileRemoved = new EventBus();

    // Outgoing data
    this.trapTriggered = new EventBus();

    // Handle incoming data
    this.fileAdded.subscribe((path, stat) => this._handleFileAdded(path, stat));
    this.fileChanged.subscribe((path, stat) => this._handleFileChanged(path, stat));
    this.fileRemoved.subscribe(path => this._handleFileRemoved(path));
  }
  isFile(path) {
    return this._evaluateFileMethod('getIsFile', path);
  }
  stat(path) {
    return this._evaluateFileMethod('getStat', path);
  }
  readModifiedTime(path) {
    return this._evaluateFileMethod('getModifiedTime', path);
  }
  readBuffer(path) {
    return this._evaluateFileMethod('getBuffer', path);
  }
  readText(path) {
    return this._evaluateFileMethod('getText', path);
  }
  readTextHash(path) {
    return this._evaluateFileMethod('getTextHash', path);
  }
  createTrap() {
    return new FileSystemTrap(this);
  }
  rehydrateTrap(dependencies) {
    return validateFileSystemDependencies(this, dependencies)
      .then(isValid => {
        if (isValid) {
          const trap = this.createTrap();
          for (var path in dependencies) {
            if (dependencies.hasOwnProperty(path)) {
              trap.bindings[path] = dependencies[path];
              this._bindTrapToFile(trap, path);
            }
          }
          return trap;
        }
        return null;
      });
  }
  _bindTrapToFile(trap, path) {
    let traps = this.trapsByFile[path];
    if (!traps) {
      traps = new Set();
      this.trapsByFile[path] = traps;
    }
    traps.add(trap);
  }
  _handleFileAdded(path, stat) {
    const file = this.files[path];
    if (!file) {
      this._createFile(path, stat);
    }

    const traps = this.trapsByFile[path];
    if (traps && traps.size) {
      const trapsToTrigger = [];
      for (const trap of traps) {
        const bindings = trap.bindings[path];
        if (bindings && bindings.isFile === false) {
          trapsToTrigger.push(trap);
        }
      }
      this._triggerTraps(trapsToTrigger, path, 'added');
    }
  }
  _handleFileChanged(path, stat) {
    this._removeFile(path);
    this._createFile(path, stat);

    const traps = this.trapsByFile[path];
    if (traps && traps.size) {
      const trapsToTrigger = [];
      for (const trap of traps) {
        if (trap.triggerOnChange[path]) {
          trapsToTrigger.push(trap);
        } else {
          const bindings = trap.bindings[path];
          if (bindings && (bindings.modifiedTime !== undefined || bindings.textHash !== undefined)) {
            trapsToTrigger.push(trap);
          }
        }
      }
      this._triggerTraps(trapsToTrigger, path, 'changed');
    }
  }
  _handleFileRemoved(path) {
    this._removeFile(path);
    const file = this._createFile(path);
    // Pre-populate the file's data
    file.setIsFile(false);

    const traps = this.trapsByFile[path];
    if (traps && traps.size) {
      const trapsToTrigger = [];
      for (const trap of traps) {
        if (trap.bindings[path].isFile === true) {
          trapsToTrigger.push(trap);
        }
      }
      this._triggerTraps(trapsToTrigger, path, 'removed');
    }
  }
  _createFile(path, stat) {
    const file = new File(path, this.fileSystem);
    if (stat) {
      // Prepopulate the file's data
      file.setStat(stat);
      file.setIsFile(stat.isFile());
      file.setModifiedTime(stat.mtime.getTime());
    }
    this.files[path] = file;
    return file;
  }
  _removeFile(path) {
    this.files[path] = null;
  }
  _evaluateFileMethod(methodName, path) {
    let file = this.files[path];
    if (!file) {
      file = this._createFile(path);
    }
    return file[methodName]()
      .catch(err => {
        const block = this._blockStaleFilesFromResolving(file);
        return block || Promise.reject(err);
      })
      .then(data => {
        const block = this._blockStaleFilesFromResolving(file);
        return block || data;
      });
  }
  _blockStaleFilesFromResolving(file) {
    // If the file was removed during processing, we prevent the promise
    // chain from continuing and rely on the traps to signal the change
    if (file !== this.files[file.path]) {
      return new Promise(() => {});
    }
    return null;
  }
  _triggerTraps(traps, path, cause) {
    const length = traps.length;
    if (length === 0) {
      return;
    }
    let i = length;
    // To avoid any inexplicable behaviour due to synchronous code evaluation
    // feeding back into the cache, we disengage every trap before signalling
    // any subscribers
    while(--i !== -1) {
      const trap = traps[i];
      for (const path in trap.bindings) {
        this.trapsByFile[path].delete(trap);
      }
    }
    i = length;
    while(--i !== -1) {
      this.trapTriggered.push({
        trap: traps[i],
        path,
        cause
      });
    }
  }
}

class FileSystemTrap {
  constructor(cache) {
    this.cache = cache;
    this.bindings = Object.create(null);
    this.boundFiles = Object.create(null);
    this.triggerOnChange = Object.create(null);
  }
  isFile(path) {
    return this.cache.isFile(path)
      .then(isFile => {
        const bindings = this._getFileBindings(path);
        if (bindings.isFile === undefined) {
          bindings.isFile = isFile;
        }
        return isFile;
      });
  }
  stat(path) {
    this._ensureBindingToFile(path);
    this.triggerOnChange[path] = true;
    return this.cache.stat(path)
      .then(stat => {
        const bindings = this._getFileBindings(path);
        bindings.isFile = true;
        if (bindings.modifiedTime === undefined) {
          bindings.modifiedTime = stat.mtime.getTime();
        }
        return stat;
      });
  }
  readModifiedTime(path) {
    this._ensureBindingToFile(path);
    this.triggerOnChange[path] = true;
    return this.cache.readModifiedTime(path)
      .then(modifiedTime => {
        const bindings = this._getFileBindings(path);
        bindings.isFile = true;
        bindings.modifiedTime = modifiedTime;
        return modifiedTime;
      });
  }
  readBuffer(path) {
    this._ensureBindingToFile(path);
    this.triggerOnChange[path] = true;
    return this.cache.readBuffer(path)
      .then(buffer => {
        // Rely on `readModifiedTime` to bind its dependencies
        return this.readModifiedTime(path)
          .then(() => buffer);
      });
  }
  readText(path) {
    this._ensureBindingToFile(path);
    this.triggerOnChange[path] = true;
    return this.cache.readText(path)
      .then(text => {
        // Rely on `readTextHash` to bind its dependencies
        return this.readTextHash(path)
          .then(() => text);
      });
  }
  readTextHash(path) {
    this._ensureBindingToFile(path);
    this.triggerOnChange[path] = true;
    return this.cache.readTextHash(path)
      .then(textHash => {
        // Rely on `readModifiedTime` to bind its dependencies
        return this.readModifiedTime(path)
          .then(() => {
            const bindings = this._getFileBindings(path);
            if (bindings.textHash === undefined) {
              bindings.textHash = textHash;
            }
            return textHash;
          });
      });
  }
  describeDependencies() {
    return this.bindings;
  }
  _ensureBindingToFile(path) {
    if (this.boundFiles[path] === undefined) {
      this.boundFiles[path] = true;
      this.cache._bindTrapToFile(this, path);
    }
  }
  _getFileBindings(path) {
    let bindings = this.bindings[path];
    if (!bindings) {
      bindings = {};
      this.bindings[path] = bindings;
      this._ensureBindingToFile(path);
    }
    return bindings;
  }
}

module.exports = {
  FileSystemCache,
  FileSystemTrap
};