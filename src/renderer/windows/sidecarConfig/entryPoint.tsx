import { createRoot } from 'react-dom/client'

import SidecarConfigApp from './SidecarConfigApp'

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(<SidecarConfigApp />)
