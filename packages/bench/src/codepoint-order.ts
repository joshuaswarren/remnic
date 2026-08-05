export function compareCodePoints(left: string, right: string): -1 | 0 | 1 {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex);
    const rightCodePoint = right.codePointAt(rightIndex);
    if (leftCodePoint === undefined || rightCodePoint === undefined) break;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  return leftIndex === left.length ? -1 : 1;
}
