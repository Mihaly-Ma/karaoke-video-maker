import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到根节点 #root，index.html 可能被修改过')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
