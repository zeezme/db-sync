import * as React from 'react'
import { Controller, FieldValues, FieldPath, ControllerProps } from 'react-hook-form'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'
import { Input } from '../primitive/input'

const inputFormVariants = cva('flex gap-1.5 flex-1', {
  variants: {
    variant: {
      vertical: 'flex-col',
      horizontal: 'flex-row items-center'
    }
  },
  defaultVariants: {
    variant: 'vertical'
  }
})

interface InputFormProps<TFieldValues extends FieldValues>
  extends Omit<React.ComponentProps<'input'>, 'name' | 'defaultValue'>,
    VariantProps<typeof inputFormVariants> {
  control: ControllerProps<TFieldValues>['control']
  name: FieldPath<TFieldValues>
  label?: string
  helperText?: string
  showError?: boolean
}

function InputForm<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  helperText,
  showError = true,
  variant,
  className,
  type,
  ...props
}: InputFormProps<TFieldValues>) {
  const isHorizontal = variant === 'horizontal'

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState: { error } }) => {
        const errorMessage = error?.message as string | undefined
        const { value, ...fieldRest } = field

        const inputValue =
          type === 'number' ? (value === undefined || value === null ? '' : value) : (value ?? '')

        return (
          <div className={cn(inputFormVariants({ variant }))}>
            {label && (
              <label
                htmlFor={name}
                className={cn(
                  'text-sm font-medium text-foreground',
                  isHorizontal && 'min-w-fit whitespace-nowrap'
                )}
              >
                {label}
              </label>
            )}

            <div className={cn('flex flex-col gap-1.5', isHorizontal && 'flex-1')}>
              <Input
                id={name}
                type={type}
                data-slot="input"
                aria-invalid={!!error}
                className={className}
                value={inputValue}
                {...fieldRest}
                onChange={(e) => {
                  const val = type === 'number' ? e.target.valueAsNumber : e.target.value
                  field.onChange(val)
                }}
                {...props}
              />

              {helperText && !error && (
                <p className="text-xs text-muted-foreground">{helperText}</p>
              )}

              {showError && errorMessage && (
                <p className="text-xs text-destructive">{errorMessage}</p>
              )}
            </div>
          </div>
        )
      }}
    />
  )
}

export { InputForm, inputFormVariants }