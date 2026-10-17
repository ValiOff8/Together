// Text operations use positive retains, negative deletes, and inserted strings.
// Both the server and browser use the same transformation rules.
function append(parts, part) {
  if (part === '' || part === 0) return;
  const last = parts.at(-1);
  if (typeof last === typeof part && (typeof part === 'string' || Math.sign(last) === Math.sign(part))) parts[parts.length - 1] += part;
  else parts.push(part);
}

export function difference(before, after) {
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const parts = [];
  append(parts, start);
  append(parts, -(before.length - start - end));
  append(parts, after.slice(start, after.length - end));
  append(parts, end);
  return parts;
}

export function operationLengths(parts) {
  if (!Array.isArray(parts) || parts.length > 4000) throw new Error('Invalid text operation.');
  let before = 0, after = 0;
  for (const part of parts) {
    if (typeof part === 'string' && part.length) after += part.length;
    else if (Number.isSafeInteger(part) && part !== 0) {
      before += Math.abs(part);
      if (part > 0) after += part;
    } else throw new Error('Invalid text operation.');
    if (before > 100000 || after > 100000) throw new Error('Text sheets can contain up to 100,000 characters.');
  }
  return { before, after };
}

export function applyOperation(content, parts) {
  if (operationLengths(parts).before !== content.length) throw new Error('Text operation does not match this version.');
  let position = 0, result = '';
  for (const part of parts) {
    if (typeof part === 'string') result += part;
    else {
      if (part > 0) result += content.slice(position, position + part);
      position += Math.abs(part);
    }
  }
  return result;
}

// Return [local after remote, remote after local]. Committed inserts win ties.
export function transformOperations(local, remote) {
  if (operationLengths(local).before !== operationLengths(remote).before) throw new Error('Text versions do not match.');
  const left = [...local], right = [...remote], a = [], b = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    const x = left[i], y = right[j];
    if (typeof y === 'string') { append(a, y.length); append(b, y); j++; }
    else if (typeof x === 'string') { append(a, x); append(b, x.length); i++; }
    else {
      if (x === undefined || y === undefined) throw new Error('Incomplete text operation.');
      const count = Math.min(Math.abs(x), Math.abs(y));
      if (x > 0 && y > 0) { append(a, count); append(b, count); }
      else if (x < 0 && y > 0) append(a, -count);
      else if (x > 0 && y < 0) append(b, -count);
      left[i] -= Math.sign(x) * count;
      right[j] -= Math.sign(y) * count;
      if (!left[i]) i++;
      if (!right[j]) j++;
    }
  }
  return [a, b];
}

export function rebaseDraft(base, content, changes) {
  let operation = difference(base, content);
  for (const change of changes) operation = transformOperations(operation, change.operation)[0];
  return operation;
}

export function acknowledgeDraft(sent, content, changes) {
  let operation = sent.operation;
  let pending = difference(sent.content, content);
  let acknowledged = false;
  for (const change of changes) {
    if (change.operation_id === sent.id) { acknowledged = true; continue; }
    if (acknowledged) pending = transformOperations(pending, change.operation)[0];
    else {
      const [rebased, remote] = transformOperations(operation, change.operation);
      operation = rebased;
      pending = transformOperations(pending, remote)[0];
    }
  }
  if (!acknowledged) throw new Error('The save could not be confirmed. Your draft is still here.');
  return pending;
}
