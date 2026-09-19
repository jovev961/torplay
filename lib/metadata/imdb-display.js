export function formatImdbRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 10
    ? rating.toFixed(1)
    : null;
}
