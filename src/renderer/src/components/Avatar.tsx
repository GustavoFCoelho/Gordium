import { colorFor, initials } from '../util'

interface Props {
  id: string
  name: string
  size?: number
  speaking?: boolean
  status?: 'online' | 'offline' | null
}

export function Avatar({ id, name, size = 32, speaking = false, status = null }: Props) {
  return (
    <div
      className={`avatar${speaking ? ' speaking' : ''}`}
      style={{ width: size, height: size, background: colorFor(id), fontSize: Math.round(size * 0.38) }}
      title={name}
    >
      {initials(name)}
      {status && <span className={`avatar-status ${status}`} />}
    </div>
  )
}
