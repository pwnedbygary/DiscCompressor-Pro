import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
}

interface ToastState {
  toasts: Toast[]
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))

export function toast(kind: ToastKind, title: string, detail?: string): void {
  const id = nextId++
  useToasts.setState((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, title, ...(detail ? { detail } : {}) }] }))
  setTimeout(() => useToasts.getState().dismiss(id), kind === 'error' ? 8000 : 4500)
}
