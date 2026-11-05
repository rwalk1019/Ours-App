import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({ className, children, title }: { className?: string; children: React.ReactNode; title: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[#2c241c]/40" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-auto rounded-t-[28px] bg-[#fbf7f1] p-5 shadow-card sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[440px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[28px]',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <DialogPrimitive.Title className="font-display text-3xl leading-none">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="rounded-full p-2 text-[#6d5d4e]" aria-label="Close">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
