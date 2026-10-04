import { useCallback, useEffect, useState } from 'react'

/** Read a setting and keep it fresh when any window changes it. Returns [value, loaded]. */
export function useSetting<T>(key: string, fallback: T): [T, boolean] {
  const [value, setValue] = useState<T>(fallback)
  const [ready, setReady] = useState(false)
  const load = useCallback(async () => {
    setValue(await window.asi.api.settings.get<T>(key, fallback))
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    void load()
    return window.asi.onChanged((topic) => { if (topic === 'settings') void load() })
  }, [load])
  return [value, ready]
}
