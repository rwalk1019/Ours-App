import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-11 w-full rounded-2xl border border-[#e0d0bd] bg-white px-3 text-base text-ink placeholder:text-[#9a8b7a] disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
