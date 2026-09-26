/**
 * Escapes angle brackets so untrusted text cannot break out of an XML-tagged prompt block. Escapes every
 * `<` and `>`, so code reads as `Array&lt;string&gt;`; the review prompts use neutralizePromptTags
 * (runners/review-prompt.ts), which escapes every `<` but keeps `>`.
 */
export function escapePromptTags(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
