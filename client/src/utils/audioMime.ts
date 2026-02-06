export const normalizeAudioMime = (value: string) => {
  const index = value.indexOf(';');
  if (index === -1) {
    return value;
  }
  return value.slice(0, index);
};
