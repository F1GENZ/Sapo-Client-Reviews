import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { reportClientError } from './common/ErrorReporter'
import { queryClient } from './common/queryClient'
import './index.css'

window.addEventListener('error', (event) => {
  reportClientError('window.error', event.error || event.message, {
    source: event.filename,
    line: event.lineno,
    column: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  reportClientError('window.unhandledrejection', event.reason)
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
