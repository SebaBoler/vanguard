import { Card as ChunksCard } from 'chunks-ui';
import type { ReactNode } from 'react';

export function Card({ children }: { children: ReactNode }) {
  return (
    <ChunksCard.Root>
      <ChunksCard.Content className="p-4">{children}</ChunksCard.Content>
    </ChunksCard.Root>
  );
}
