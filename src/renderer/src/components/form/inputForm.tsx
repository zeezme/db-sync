import * as React from 'react'
import { useFormContext } from 'react-hook-form'
import { cn } from '@renderer/lib/utils'

interface InputFormProps extends Omit<React.ComponentProps<'input'>, 'name'> {
  name: string
  label?: string
  helperText?: string
  showError?: boolean
}

function InputForm({
  name,
  label,
  helperText,
  showError = true,
  className,
  type,
  ...props
}: InputFormProps) {
  const {
    register,
    formState: { errors }
  } = useFormContext()

  const error = errors[name]
  const errorMessage = error?.message as string | undefined

  const registerOptions = type === 'number' ? { valueAsNumber: true } : {}

  return (
    <div className="flex flex-col gap-1.5 flex-1">
      {label && (
        <label htmlFor={name} className="text-sm font-medium text-foreground">
          {label}
        </label>
      )}

      <input
        id={name}
        type={type}
        data-slot="input"
        aria-invalid={!!error}
        className={cn(
          'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
          className
        )}
        {...register(name, registerOptions)}
        {...props}
      />

      {helperText && !error && <p className="text-xs text-muted-foreground">{helperText}</p>}

      {showError && errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}
    </div>
  )
}

export { InputForm }
