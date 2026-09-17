export function parseByteRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { error: true };
  }

  if (!header) {
    return { start: 0, end: size - 1, partial: false };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) {
    return { error: true };
  }

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { error: true };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { error: true };
    }
    end = Math.min(end, size - 1);
  }

  if (start < 0 || start >= size || end < start) {
    return { error: true };
  }

  return { start, end, partial: true };
}
