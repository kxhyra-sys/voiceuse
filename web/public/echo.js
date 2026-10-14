// Speakers playing a reply out loud can reach the mic, so speech recognition hears the reply back.
// This tells whether something heard is the reply itself rather than the person answering it.

const words = (text) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);

export function isEcho(heard, spoken) {
  if (!heard || !spoken) return false;
  const said = words(heard);
  const reply = words(spoken);
  if (said.length < 2 || !reply.length) return false;

  // A run of two or more words straight out of the reply ("I compared", "Should I open the").
  if (` ${reply.join(" ")} `.includes(` ${said.join(" ")} `)) return true;

  // Recognition often garbles an echo slightly, so also catch longer phrases made almost entirely
  // of the reply's words. Short answers like "yes please" stay below this bar.
  if (said.length < 4) return false;
  const vocabulary = new Set(reply);
  const shared = said.filter((w) => vocabulary.has(w)).length;
  return shared / said.length >= 0.8;
}
