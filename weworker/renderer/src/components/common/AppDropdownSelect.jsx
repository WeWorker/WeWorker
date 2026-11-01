import React, { useEffect, useId, useRef, useState } from 'react'
import { CheckOutlined, DeleteOutlined, DownOutlined } from '@ant-design/icons'
import { dropdownMenuItemClassName } from './dropdown-menu-styles.js'
import { DropdownMenuPortal, useDropdownDismiss } from './DropdownMenuPortal.jsx'
import StyleKindIcon from './StyleKindIcon.jsx'
import { buildCustomOption, filterDropdownOptions } from '../../utils/dropdown-select.js'

export default function AppDropdownSelect({
  value,
  options = [],
  onChange,
  disabled = false,
  ariaLabel,
  prefix,
  minMenuWidth = 160,
  matchAnchorWidth = false,
  placement = 'bottom',
  className = '',
  menuClassName,
  showOptionIcons = false,
  renderOptionSuffix,
  onRemoveOption,
  fallbackOption,
  menuHeader,
  required = false,
  // 可选能力：默认关闭，不传时组件行为、DOM 结构与可访问性属性与旧版完全一致。
  searchable = false,
  allowCustom = false,
  searchPlaceholder = '搜索',
  customOptionLabel,
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const searchInputRef = useRef(null)

  // allowCustom 时即使没有可选列表也允许打开菜单；默认仍受空列表限制。
  const canOpenMenu = allowCustom || options.length > 0
  const matchedOption = options.find((item) => item.value === value)
  // allowCustom 下，value 不在 options 里时直接显示用户填写的值，不回退到 options[0]。
  const customSelection = !matchedOption && allowCustom && String(value ?? '').trim()
    ? { value, label: String(value).trim() }
    : null
  const selected = matchedOption || customSelection || fallbackOption || options[0]

  const closeMenu = () => {
    setOpen(false)
    setQuery('')
  }

  useDropdownDismiss(open, closeMenu, triggerRef, menuRef)

  // 菜单打开时自动聚焦搜索框（菜单由 Portal 延迟一帧挂载，所以放到下一帧执行）。
  useEffect(() => {
    if (!open || !searchable) return undefined
    const raf = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, searchable])

  const toggleOpen = () => {
    if (disabled || !canOpenMenu) return
    setOpen((current) => !current)
  }

  const visibleOptions = searchable ? filterDropdownOptions(options, query) : options
  // 只有 allowCustom 且输入了与已有选项不重复的值时才出现自定义行。
  const customOption = allowCustom ? buildCustomOption(query, options) : null
  const customOptionText = customOption
    ? (typeof customOptionLabel === 'function' && customOptionLabel(customOption.value)) || `使用 “${customOption.value}”`
    : ''

  const commitValue = (nextValue) => {
    onChange?.(nextValue)
    closeMenu()
    triggerRef.current?.focus()
  }

  const focusFirstOption = () => {
    menuRef.current?.querySelector('[role="option"]:not(:disabled)')?.focus()
  }

  const handleSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusFirstOption()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (customOption) {
        commitValue(customOption.value)
        return
      }
      const only = visibleOptions.length === 1 ? visibleOptions[0] : null
      if (only && !disabled && !only.disabled) commitValue(only.value)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      triggerRef.current?.focus()
    }
  }

  return (
    <div className={`app-dropdown-select ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="app-dropdown-select__trigger"
        disabled={disabled || !canOpenMenu}
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listId : undefined}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault()
            setOpen(true)
            requestAnimationFrame(() => {
              const menu = menuRef.current
              const option = menu?.querySelector('[role="option"][aria-selected="true"]:not(:disabled)')
                || menu?.querySelector('[role="option"]:not(:disabled)')
              option?.focus()
            })
          }
        }}
      >
        {prefix ? <span className="app-dropdown-select__prefix">{prefix}</span> : null}
        <span className="app-dropdown-select__label">{selected?.label || '请选择'}</span>
        {renderOptionSuffix?.(selected)}
        <DownOutlined className="app-dropdown-select__caret" aria-hidden="true" />
      </button>
      {required && <input className="app-dropdown-select__validation" tabIndex={-1} aria-hidden="true" required disabled={disabled} value={value ?? ''} onChange={() => {}} onInvalid={(event) => { event.preventDefault(); triggerRef.current?.focus() }} />}

      <DropdownMenuPortal
        ref={menuRef}
        open={open}
        anchorRef={triggerRef}
        minWidth={minMenuWidth}
        matchAnchorWidth={matchAnchorWidth}
        placement={placement}
        className={menuClassName}
      >
        {searchable ? (
          <div className="app-dropdown-select__search">
            <input
              ref={searchInputRef}
              type="text"
              className="app-dropdown-select__search-input"
              value={query}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-label={ariaLabel ? `${ariaLabel} 搜索` : '搜索'}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              onChange={(event) => {
                setQuery(event.target.value)
                const list = menuRef.current?.querySelector('[role="listbox"]')
                if (list) list.scrollTop = 0
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
        ) : null}
        {menuHeader}
        <div id={listId} role="listbox" aria-label={ariaLabel} onKeyDown={(event) => {
          const items = [...event.currentTarget.querySelectorAll('[role="option"]:not(:disabled)')]
          const index = items.indexOf(document.activeElement)
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
            items[next]?.focus()
          }
          if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
            triggerRef.current?.focus()
          }
        }}>
          {customOption ? (
            <button
              type="button"
              role="option"
              aria-selected={value === customOption.value}
              onClick={() => commitValue(customOption.value)}
              className={`${dropdownMenuItemClassName({ selected: value === customOption.value })} app-dropdown-select__custom-option`}
            >
              <span className="app-dropdown-menu-item__label">{customOptionText}</span>
              <DropdownMenuCheck selected={value === customOption.value} />
            </button>
          ) : null}
          {visibleOptions.map((option) => {
            const removable = option.removable === true && typeof onRemoveOption === 'function'
            const optionButton = (
              <button
                type="button"
                role="option"
                aria-selected={value === option.value}
                disabled={disabled || option.disabled}
                onClick={() => {
                  onChange?.(option.value)
                  closeMenu()
                  triggerRef.current?.focus()
                }}
                className={dropdownMenuItemClassName({ selected: value === option.value, rich: Boolean(option.description) })}
              >
                {option.description ? (
                  <span className="app-dropdown-menu-item__content">
                    {showOptionIcons && option.kind ? (
                      <span className="app-dropdown-menu-item__icon" aria-hidden="true">
                        <StyleKindIcon kind={option.kind} size={14} />
                      </span>
                    ) : null}
                    <span className="app-dropdown-menu-item__label">{option.label}</span>
                    <span className="app-dropdown-menu-item__desc">{option.description}</span>
                  </span>
                ) : (
                  <span className="app-dropdown-menu-item__label">{option.label}</span>
                )}
                {renderOptionSuffix?.(option)}
                <DropdownMenuCheck selected={value === option.value} />
              </button>
            )
            return removable ? (
              <div key={option.value} className="app-dropdown-select__removable-option">
                {optionButton}
                <button
                  type="button"
                  className="app-dropdown-select__remove-option"
                  aria-label={`删除自定义模型 ${option.label}`}
                  title="删除自定义模型"
                  onClick={() => onRemoveOption(option.value)}
                >
                  <DeleteOutlined aria-hidden="true" />
                </button>
              </div>
            ) : React.cloneElement(optionButton, { key: option.value })
          })}
          {searchable && !customOption && visibleOptions.length === 0 ? (
            <div className="app-dropdown-select__empty" role="presentation">
              {String(query).trim() ? '没有匹配项' : '暂无可选内容，可直接输入'}
            </div>
          ) : null}
        </div>
      </DropdownMenuPortal>
    </div>
  )
}

export function DropdownMenuCheck({ selected }) {
  return <CheckOutlined className="app-dropdown-menu-check-icon" style={{ visibility: selected ? 'visible' : 'hidden' }} aria-hidden="true" />
}
