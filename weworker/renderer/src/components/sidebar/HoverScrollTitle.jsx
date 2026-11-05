import React, { useLayoutEffect, useRef, useState } from 'react'

export default function HoverScrollTitle({ children, active }) {
  const viewportRef = useRef(null)
  const textRef = useRef(null)
  const [distance, setDistance] = useState(0)
  const [atEnd, setAtEnd] = useState(false)

  useLayoutEffect(() => {
    const measure = () => {
      setDistance(Math.max(0, textRef.current.scrollWidth - viewportRef.current.clientWidth))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewportRef.current)
    observer.observe(textRef.current)
    return () => observer.disconnect()
  }, [active, children])

  useLayoutEffect(() => {
    setAtEnd(false)
  }, [active, children, distance])

  return (
    <span ref={viewportRef} className={`work-title-viewport${distance > 1 ? ' is-overflowing' : ''}${active && distance > 1 ? ' is-scrolling' : ''}${active && atEnd ? ' is-at-end' : ''}`}
      style={{ '--title-scroll-distance': `${-distance}px`, '--title-scroll-duration': `${Math.max(distance / 28, 1)}s` }}>
      <span ref={textRef} className="work-title-text" onAnimationEnd={() => setAtEnd(true)}>{children}</span>
    </span>
  )
}
