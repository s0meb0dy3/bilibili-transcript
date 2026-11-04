// Replace this provider later without changing segmentation or the panel.
const defaultPerson = Object.freeze({ id: 'unknown', name: '未标注', avatarUrl: null });

export function getPerson(_speakerId) {
  return defaultPerson;
}
