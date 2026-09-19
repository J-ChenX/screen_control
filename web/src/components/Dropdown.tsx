import { useEffect, useId, useRef, useState, type ReactNode, type KeyboardEvent } from "react";

interface Choice<T extends string> { value: T; label: ReactNode; disabled?: boolean }

// 使用顶层弹出层，避免文件框和控屏弹窗裁切菜单；始终从触发按钮下方展开。
export function Dropdown<T extends string>({ label, value, options, onChange, disabled = false, children, className = "" }: {
  label: string; value: T; options: Choice<T>[]; onChange: (value: T) => void;
  disabled?: boolean; children: ReactNode; className?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) menu.current?.hidePopover();
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { if (!menu.current?.contains(event.target as Node)) menu.current?.hidePopover(); };
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => { window.removeEventListener("resize", dismiss); document.removeEventListener("scroll", dismiss, true); };
  }, [open]);
  const close = () => { menu.current?.hidePopover(); trigger.current?.focus(); };
  const show = () => {
    if (disabled || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 160), window.innerWidth - 16);
    Object.assign(menu.current.style, { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`, top: `${rect.bottom + 6}px`, width: `${width}px`, maxHeight: `${Math.max(48, window.innerHeight - rect.bottom - 14)}px` });
    menu.current.showPopover();
    const buttons = Array.from(menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    (buttons.find(button => button.getAttribute('aria-selected') === 'true') ?? buttons[0])?.focus({ preventScroll: true });
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") close();
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  };
  return <div className={`custom-dropdown ${className}`}>
    <button ref={trigger} type="button" className="custom-dropdown-trigger" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} onClick={() => open ? close() : show()} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(); } }}>
      {children}<span className="dropdown-chevron" aria-hidden="true">⌄</span>
    </button>
    <div id={id} ref={menu} popover="auto" className="custom-dropdown-menu" role="listbox" aria-label={label} onKeyDown={keys} onToggle={() => setOpen(Boolean(menu.current?.matches(':popover-open')))}>
      {options.map(option => <button key={option.value} type="button" role="option" tabIndex={-1} aria-selected={option.value === value} disabled={disabled || option.disabled} onClick={() => { onChange(option.value); close(); }}>
        <span className="dropdown-option-content">{option.label}</span><span className="dropdown-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
      </button>)}
    </div>
  </div>;
}
