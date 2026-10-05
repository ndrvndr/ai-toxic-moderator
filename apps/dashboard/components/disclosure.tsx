'use client';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useState, type ReactNode } from 'react';

/** Shared disclosure built from shadcn primitives; refreshes preserve its open state. */
export function Disclosure({
  title,
  children,
  className,
  triggerClassName,
  open,
  onOpenChange,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible
      className={className}
      open={open ?? expanded}
      onOpenChange={onOpenChange ?? setExpanded}
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={triggerClassName ?? 'h-auto justify-start px-0 py-2 text-xs'}
        >
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="data-[state=closed]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
