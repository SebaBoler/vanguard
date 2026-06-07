export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function assistantText(msg: { message?: { content?: Array<{ type?: string; text?: string }> } }): string {
  return (msg.message?.content ?? [])
    .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('');
}
