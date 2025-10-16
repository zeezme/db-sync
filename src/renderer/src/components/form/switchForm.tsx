import * as React from 'react'
import { Controller, FieldValues, FieldPath, ControllerProps } from 'react-hook-form'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'
import { Switch } from '../primitive/switch'

const switchFormVariants = cva('flex gap-2', {
  variants: {
    variant: {
      vertical: 'flex-col',
      horizontal: 'flex-row items-center'
    }
  },
  defaultVariants: {
    variant: 'horizontal'
  }
})

interface SwitchFormProps<TFieldValues extends FieldValues>
  extends Omit<
      React.ComponentProps<typeof Switch>,
      'name' | 'defaultValue' | 'checked' | 'onCheckedChange'
    >,
    VariantProps<typeof switchFormVariants> {
  control: ControllerProps<TFieldValues>['control']
  name: FieldPath<TFieldValues>
  label?: string
  helperText?: string
  showError?: boolean
}

function SwitchForm<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  helperText,
  showError = true,
  variant,
  className,
  ...props
}: SwitchFormProps<TFieldValues>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState: { error } }) => {
        const errorMessage = error?.message as string | undefined

        return (
          <div className="flex flex-col gap-1.5">
            <div className={cn(switchFormVariants({ variant }))}>
              <Switch
                id={name}
                checked={field.value}
                onCheckedChange={field.onChange}
                className={className}
                {...props}
              />

              {label && (
                <label
                  htmlFor={name}
                  className="text-sm font-medium text-foreground cursor-pointer"
                >
                  {label}
                </label>
              )}
            </div>

            {helperText && !error && <p className="text-xs text-muted-foreground">{helperText}</p>}

            {showError && errorMessage && (
              <p className="text-xs text-destructive">{errorMessage}</p>
            )}
          </div>
        )
      }}
    />
  )
}

export { SwitchForm, switchFormVariants }
