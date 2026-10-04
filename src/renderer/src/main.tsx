import './excalidraw-env' // before anything lazy: the library reads it when its chunk loads
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
