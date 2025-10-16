import * as React from 'react'
import { Controller, FieldValues, FieldPath, ControllerProps } from 'react-hook-form'
import { Textarea } from '../primitive/textarea'

interface TextareaFormProps<TFieldValues extends FieldValues>
  extends Omit<React.ComponentProps<'textarea'>, 'name' | 'defaultValue'> {
  control: ControllerProps<TFieldValues>['control']
  name: FieldPath<TFieldValues>
  label?: string
  helperText?: string
  showError?: boolean
}

function TextareaForm<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  helperText,
  showError = true,
  className,
  ...props
}: TextareaFormProps<TFieldValues>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState: { error } }) => {
        const errorMessage = error?.message as string | undefined

        return (
          <div className="flex flex-col gap-1.5">
            {label && (
              <label htmlFor={name} className="text-sm font-medium text-foreground">
                {label}
              </label>
            )}

            <Textarea
              id={name}
              data-slot="textarea"
              aria-invalid={!!error}
              className={className}
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
              {...props}
            />

            {helperText && !error && (
              <p className="text-xs text-muted-foreground">{helperText}</p>
            )}

            {showError && errorMessage && (
              <p className="text-xs text-destructive">{errorMessage}</p>
            )}
          </div>
        )
      }}
    />
  )
}

export { TextareaForm }