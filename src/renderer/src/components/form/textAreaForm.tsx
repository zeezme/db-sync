import * as React from 'react'
import { useFormContext } from 'react-hook-form'
import { cn } from '@renderer/lib/utils'

interface TextareaFormProps extends Omit<React.ComponentProps<'textarea'>, 'name'> {
  name: string
  label?: string
  helperText?: string
  showError?: boolean
}

function TextareaForm({
  name,
  label,
  helperText,
  showError = true,
  className,
  ...props
}: TextareaFormProps) {
  const {
    register,
    formState: { errors }
  } = useFormContext()

  const error = errors[name]
  const errorMessage = error?.message as string | undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={name} className="text-sm font-medium text-foreground">
          {label}
        </label>
      )}

      <textarea
        id={name}
        data-slot="textarea"
        aria-invalid={!!error}
        className={cn(
          'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className
        )}
        {...register(name)}
        {...props}
      />

      {helperText && !error && <p className="text-xs text-muted-foreground">{helperText}</p>}

      {showError && errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}
    </div>
  )
}

export { TextareaForm }
