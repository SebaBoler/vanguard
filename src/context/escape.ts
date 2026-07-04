/** Escapes angle brackets so untrusted text cannot break out of an XML-tagged prompt block. */
export function escapePromptTags(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
