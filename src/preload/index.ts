import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('asi', { platform: process.platform })
