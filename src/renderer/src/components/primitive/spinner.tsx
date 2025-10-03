import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const spinnerVariants = cva(
  'inline-flex items-center justify-center animate-spin [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'text-primary',
        destructive: 'text-destructive',
        secondary: 'text-secondary',
        outline: 'text-foreground',
        ghost: 'text-accent-foreground',
        link: 'text-primary'
      },
      size: {
        default: 'size-4',
        sm: 'size-3',
        lg: 'size-5',
        icon: 'size-4'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Spinner({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof spinnerVariants>) {
  return (
    <div
      data-slot="spinner"
      className={cn(spinnerVariants({ variant, size, className }))}
      {...props}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="100%"
        height="100%"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>
  )
}

export { Spinner, spinnerVariants }
