'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface ImageLightboxProps {
  src: string;
  filename: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ImageLightbox = ({ src, filename, isOpen, onClose }: ImageLightboxProps) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const zoomRef = useRef(zoom);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Focus management: move focus into the dialog on open, restore it on close
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      const id = requestAnimationFrame(() => containerRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  }, [isOpen]);

  // Reset zoom/pan when opening
  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    onClose();
  }, [onClose]);

  // Escape to close, Tab to stay trapped inside the dialog, arrow keys to pan when zoomed
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key === 'Tab') {
        const container = containerRef.current;
        if (!container) return;
        const focusable = Array.from(
          container.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (zoomRef.current > 1 && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const step = 40;
        setPan((prev) => {
          switch (e.key) {
            case 'ArrowUp': return { x: prev.x, y: prev.y - step };
            case 'ArrowDown': return { x: prev.x, y: prev.y + step };
            case 'ArrowLeft': return { x: prev.x - step, y: prev.y };
            case 'ArrowRight': return { x: prev.x + step, y: prev.y };
            default: return prev;
          }
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  // Prevent body scroll while open
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setZoom((prev) => {
      const next = prev - e.deltaY * 0.001;
      return Math.min(Math.max(next, 0.5), 5);
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [zoom, pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !dragStart.current) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStart.current = null;
  }, []);

  const zoomIn = () => setZoom((z) => Math.min(z + 0.5, 5));
  const zoomOut = () => {
    setZoom((z) => {
      const next = Math.max(z - 0.5, 0.5);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="lightbox-backdrop"
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={filename}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center outline-none"
          style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}
          onClick={handleClose}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Controls — top bar */}
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.2, delay: 0.05 }}
            className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-4 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Filename */}
            <span className="text-relay-text-secondary text-sm font-medium truncate max-w-xs select-none">
              {filename}
            </span>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={zoomOut}
                className="p-2 rounded-lg bg-relay-surface-hover/80 hover:bg-relay-surface-hover text-relay-text-secondary hover:text-white transition-colors"
                title="Zoom out"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-relay-text-secondary text-xs font-mono min-w-[3rem] text-center select-none">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={zoomIn}
                className="p-2 rounded-lg bg-relay-surface-hover/80 hover:bg-relay-surface-hover text-relay-text-secondary hover:text-white transition-colors"
                title="Zoom in"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              {zoom !== 1 && (
                <button
                  onClick={reset}
                  className="p-2 rounded-lg bg-relay-surface-hover/80 hover:bg-relay-surface-hover text-relay-text-secondary hover:text-white transition-colors"
                  title="Reset zoom"
                  aria-label="Reset zoom"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              <a
                href={src}
                download={filename}
                className="p-2 rounded-lg bg-relay-surface-hover/80 hover:bg-relay-surface-hover text-relay-text-secondary hover:text-white transition-colors"
                title="Download"
                aria-label="Download image"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="w-4 h-4" />
              </a>
              <button
                onClick={handleClose}
                className="p-2 rounded-lg bg-relay-surface-hover/80 hover:bg-red-500/15 text-relay-text-secondary hover:text-white transition-colors"
                title="Close (Esc)"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>

          {/* Image */}
          <motion.div
            key="lightbox-image"
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.88 }}
            transition={{ duration: 0.22, type: 'spring', stiffness: 320, damping: 28 }}
            className="relative max-w-[90vw] max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            style={{
              cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
              userSelect: 'none',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={filename}
              draggable={false}
              style={{
                maxWidth: '90vw',
                maxHeight: '85vh',
                width: 'auto',
                height: 'auto',
                display: 'block',
                borderRadius: '8px',
                transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.15s ease',
                boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
              }}
            />
          </motion.div>

          {/* Zoom hint */}
          {zoom === 1 && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="absolute bottom-5 left-1/2 -translate-x-1/2 text-relay-text-muted text-xs select-none pointer-events-none"
            >
              Scroll to zoom · Click outside to close
            </motion.p>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
