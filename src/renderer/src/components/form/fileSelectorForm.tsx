import * as React from 'react'
import { Controller, FieldValues, FieldPath, ControllerProps } from 'react-hook-form'
import { cn } from '@renderer/lib/utils'
import { Folder, File } from 'lucide-react'
import { Button } from '@renderer/components/primitive/button'
import { Input } from '../primitive/input'

interface FileSelectorFormProps<TFieldValues extends FieldValues>
  extends Omit<React.ComponentProps<'input'>, 'name' | 'type' | 'defaultValue'> {
  control: ControllerProps<TFieldValues>['control']
  name: FieldPath<TFieldValues>
  label?: string
  helperText?: string
  showError?: boolean
  mode?: 'file' | 'directory'
  buttonText?: string
  buttonVariant?: 'default' | 'outline' | 'secondary' | 'ghost'
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon'
}

function FileSelectorForm<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  helperText,
  showError = true,
  mode = 'directory',
  buttonText,
  buttonVariant = 'outline',
  buttonSize = 'sm',
  className,
  disabled,
  ...props
}: FileSelectorFormProps<TFieldValues>) {
  const defaultButtonText =
    buttonText || (mode === 'directory' ? 'Selecionar Diretório' : 'Selecionar Arquivo')
  const Icon = mode === 'directory' ? Folder : File

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState: { error } }) => {
        const errorMessage = error?.message as string | undefined

        const handleSelect = async () => {
          try {
            const ipcMethod = mode === 'directory' ? 'select-directory' : 'select-file'
            const result = await window.electron.ipcRenderer.invoke(ipcMethod)

            if (result && !result.canceled && result.filePaths.length > 0) {
              field.onChange(result.filePaths[0])
            }
          } catch (error) {
            console.error(
              `Erro ao selecionar ${mode === 'directory' ? 'diretório' : 'arquivo'}:`,
              error
            )
          }
        }

        return (
          <div className="flex flex-col gap-1.5">
            {label && (
              <label htmlFor={name} className="text-sm font-medium text-foreground">
                {label}
              </label>
            )}

            <div className="flex gap-2">
              <Input
                id={name}
                type="text"
                readOnly
                data-slot="input"
                aria-invalid={!!error}
                value={field.value || ''}
                placeholder={
                  props.placeholder ||
                  `Nenhum ${mode === 'directory' ? 'diretório' : 'arquivo'} selecionado`
                }
                className={cn(
                  'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
                  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                  'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
                  'cursor-default',
                  className
                )}
                disabled={disabled}
                {...props}
              />

              <Button
                type="button"
                variant={buttonVariant}
                size={buttonSize}
                onClick={handleSelect}
                disabled={disabled}
                className="h-full"
              >
                <Icon className="mr-2" />
                {defaultButtonText}
              </Button>
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

export { FileSelectorForm }