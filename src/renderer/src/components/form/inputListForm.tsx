import * as React from 'react'
import { Controller, FieldValues, FieldPath, ControllerProps } from 'react-hook-form'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/primitive/button'
import { X, Plus, ChevronDown } from 'lucide-react'
import { Badge } from '../primitive/badge'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@renderer/components/primitive/dropdown-menu'

interface InputListFormProps<TFieldValues extends FieldValues> {
  control: ControllerProps<TFieldValues>['control']
  name: FieldPath<TFieldValues>
  label?: string
  helperText?: string
  showError?: boolean
  placeholder?: string
  disabled?: boolean
}

function InputListForm<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  helperText,
  showError = true,
  placeholder = 'Digite um item...',
  disabled = false
}: InputListFormProps<TFieldValues>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState: { error } }) => (
        <InputListFormContent
          field={field}
          error={error}
          name={name}
          label={label}
          helperText={helperText}
          showError={showError}
          placeholder={placeholder}
          disabled={disabled}
        />
      )}
    />
  )
}

interface InputListFormContentProps {
  field: any
  error: any
  name: string
  label?: string
  helperText?: string
  showError: boolean
  placeholder: string
  disabled: boolean
}

function InputListFormContent({
  field,
  error,
  name,
  label,
  helperText,
  showError,
  placeholder,
  disabled
}: InputListFormContentProps) {
  const [inputValue, setInputValue] = React.useState('')
  const [maxVisibleItems, setMaxVisibleItems] = React.useState<number>(0)
  const [inputError, setInputError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const badgeRefs = React.useRef<React.RefObject<HTMLSpanElement>[]>([])
  const maisButtonRef = React.useRef<HTMLButtonElement>(null)

  const MAX_ITEM_LENGTH = 50

  const items = React.useMemo(() => {
    if (!field.value || typeof field.value !== 'string') return []
    return field.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }, [field.value])

  React.useEffect(() => {
    badgeRefs.current = items.map(
      (_, index) => badgeRefs.current[index] || React.createRef<HTMLSpanElement>()
    )
  }, [items])

  const calculateMaxVisible = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const containerWidth = container.clientWidth
    if (containerWidth === 0) {
      setTimeout(() => requestAnimationFrame(calculateMaxVisible), 0)
      return
    }

    const gap = 8
    const padding = 16
    const inputMinWidth = 120
    const addButtonWidth = 24
    const maisButtonWidth = maisButtonRef.current ? maisButtonRef.current.offsetWidth : 60

    const reservedSpace = inputMinWidth + addButtonWidth + padding + gap * 2
    const availableWidth = containerWidth - reservedSpace

    let totalWidth = 0
    let maxItems = 0

    for (let i = 0; i < items.length; i++) {
      const badge = badgeRefs.current[i]?.current
      const badgeWidth = badge ? badge.offsetWidth : 80

      const willHaveMore = i < items.length - 1
      const extraSpace = willHaveMore ? maisButtonWidth + gap : 0

      if (totalWidth + badgeWidth + gap + extraSpace <= availableWidth) {
        totalWidth += badgeWidth + gap
        maxItems++
      } else {
        break
      }
    }

    setMaxVisibleItems(maxItems || items.length)
  }, [items.length])

  React.useEffect(() => {
    setMaxVisibleItems(items.length)
    const timer = setTimeout(() => requestAnimationFrame(calculateMaxVisible), 0)
    return () => clearTimeout(timer)
  }, [items.length, calculateMaxVisible])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(calculateMaxVisible)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [calculateMaxVisible])

  const handleAdd = React.useCallback(() => {
    if (disabled) return

    const trimmed = inputValue.trim()
    if (!trimmed) return

    if (trimmed.length > MAX_ITEM_LENGTH) {
      setInputError(`O item não pode exceder ${MAX_ITEM_LENGTH} caracteres.`)
      return
    }

    if (items.includes(trimmed)) {
      setInputError('Este item já foi adicionado.')
      setInputValue('')
      return
    }

    setInputError(null)
    const newItems = [...items, trimmed]
    field.onChange(newItems.join(', '))
    setInputValue('')
  }, [disabled, inputValue, items, field])

  const handleRemove = React.useCallback(
    (itemToRemove: string) => {
      if (disabled) return

      const newItems = items.filter((t) => t !== itemToRemove)
      field.onChange(newItems.join(', '))
      setInputError(null)
    },
    [disabled, items, field]
  )

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleAdd()
      }
    },
    [handleAdd]
  )

  const errorMessage = error?.message as string | undefined
  const hiddenItems = items.slice(maxVisibleItems)
  const hiddenCount = hiddenItems.length

  const MemoizedDropdown = React.memo(
    ({ hiddenItems, hiddenCount }: { hiddenItems: string[]; hiddenCount: number }) => (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={maisButtonRef}
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-6 text-xs flex items-center gap-1 shrink-0"
          >
            <ChevronDown className="h-3 w-3" />
            {hiddenCount} mais
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-w-xs">
          {hiddenItems.map((item) => (
            <DropdownMenuItem key={item} className="flex justify-between items-center gap-2">
              <span className="text-xs truncate">{item}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  handleRemove(item)
                }}
                disabled={disabled}
                className="hover:bg-destructive/20 rounded-full p-0.5 transition-colors"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  )
  MemoizedDropdown.displayName = 'MemoizedDropdown'

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={name} className="text-sm font-medium text-foreground">
          {label}
        </label>
      )}

      <div
        className={cn(
          'border-input focus-within:border-ring focus-within:ring-ring/50 dark:bg-input/30 flex w-full rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]',
          (error || inputError) &&
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <div
          ref={containerRef}
          className="flex w-full items-center gap-2 px-2 py-[2px] overflow-hidden"
          style={{ flexWrap: 'nowrap' }}
        >
          {items.slice(0, maxVisibleItems).map((item, index) => (
            <Badge
              key={item}
              variant="secondary"
              className="flex items-center gap-1 shrink-0"
              ref={badgeRefs.current[index]}
            >
              <span className="text-xs">{item}</span>
              <button
                type="button"
                onClick={() => handleRemove(item)}
                disabled={disabled}
                className="ml-1 hover:bg-destructive/20 rounded-full p-0.5 transition-colors"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}

          <input
            id={name}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setInputError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder={items.length === 0 ? placeholder : ''}
            disabled={disabled}
            className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none px-1 h-8 min-w-[120px]"
          />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleAdd}
            disabled={!inputValue.trim() || disabled}
            className="h-6 w-6 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>

          {hiddenCount > 0 && (
            <MemoizedDropdown hiddenItems={hiddenItems} hiddenCount={hiddenCount} />
          )}
        </div>
      </div>

      {helperText && !error && !inputError && (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      )}

      {showError && (errorMessage || inputError) && (
        <p className="text-xs text-destructive">{errorMessage || inputError}</p>
      )}
    </div>
  )
}

export { InputListForm }