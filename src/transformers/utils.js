import {isUndefined, isString, isObject, isArray} from 'lodash/lang';
import {forEach} from 'lodash/collection';
import {startsWith} from 'lodash/string';

export function cloneWithoutUnderscoreProps(node) {
  var accumulator;
  if (isArray(node)) {
    accumulator = [];
  } else {
    accumulator = {};
  }

  forEach(node, function(value, key) {
    if (!startsWith(key, '_')) {
      if (isObject(value)) {
        accumulator[key] = cloneWithoutUnderscoreProps(value);
      } else {
        accumulator[key] = value;
      }
    }
  });

  return accumulator;
}