// Anonymous labels are local to one ASR result, never real-world identities.
export function getPerson(speakerId, people = {}) {
  const inferred = people[String(speakerId)];
  if (inferred?.name) return { ...inferred, name: inferred.name, avatarUrl: null };
  if (speakerId === undefined || speakerId === null || speakerId === 'unknown') {
    return { id: 'unknown', name: '未知发言人', avatarUrl: null };
  }
  const label = /^\d+$/.test(String(speakerId)) ? Number(speakerId) + 1 : speakerId;
  return { id: String(speakerId), name: `未知发言人 ${label}`, avatarUrl: null };
}
