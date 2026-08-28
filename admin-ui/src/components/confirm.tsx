import { createContext, useCallback, useContext, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CircleAlertIcon } from 'lucide-react'

export interface ConfirmOptions {
  title: string
  text?: string
  yes?: string
  no?: string
  danger?: boolean
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(async () => false)

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null)
  const busyRef = useRef(false)

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve })
    })
  }, [])

  const settle = (ok: boolean) => {
    if (!state || busyRef.current) return
    busyRef.current = true
    state.resolve(ok)
    setState(null)
    // allow the close transition before the next confirm reuses the ref
    setTimeout(() => {
      busyRef.current = false
    }, 50)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={state !== null}
        onOpenChange={(open) => {
          if (!open) settle(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            {state?.danger && (
              <AlertDialogMedia>
                <CircleAlertIcon className="text-destructive" />
              </AlertDialogMedia>
            )}
            <AlertDialogTitle>{state?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {state?.text}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{state?.no ?? '取消'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              variant={state?.danger ? 'destructive' : 'default'}
            >
              {state?.yes ?? '确认'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}
