import { useState } from "react"

export function Counter() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN((v) => v + 1)}>clicked {n} times</button>
}
