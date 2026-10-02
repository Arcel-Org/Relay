'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Lock } from 'lucide-react';

interface PINPadSetupProps {
  onSubmit: (pin: string) => void;
  onPinChange?: (pin: string) => void;
  shake?: boolean;
  isLoading?: boolean;
}

const PIN_BUTTONS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'backspace', '0', 'enter'];

export const PINPadSetup = ({
  onSubmit,
  onPinChange,
  shake = false,
  isLoading = false,
}: PINPadSetupProps) => {
  const [pin, setPin] = useState('');

  useEffect(() => {
    onPinChange?.(pin);
  }, [pin, onPinChange]);

  const handleDigit = (digit: string) => {
    if (digit === 'backspace') {
      setPin(pin.slice(0, -1));
    } else if (digit === 'enter') {
      if (pin.length === 6) {
        onSubmit(pin);
        setPin('');
      }
    } else if (pin.length < 6) {
      setPin(pin + digit);
    }
  };

  const getButtonLabel = (digit: string) => {
    if (digit === 'backspace') return 'Delete last digit';
    if (digit === 'enter') return 'Confirm PIN';
    return `Digit ${digit}`;
  };

  const getButtonColor = (digit: string) => {
    if (digit === 'backspace' || digit === 'enter') {
      return 'bg-relay-accent hover:bg-relay-accent/90 text-white';
    }
    return 'bg-relay-surface-hover hover:bg-relay-surface-hover text-relay-text-primary';
  };

  return (
    <motion.div
      className="space-y-8"
      animate={shake ? { x: [-10, 10, -10, 10, 0] } : {}}
      transition={{ duration: 0.5 }}
    >
      {/* PIN Display */}
      <div className="flex justify-center">
        <div className="inline-block px-6 py-4 bg-relay-surface/50 border border-relay-border rounded-lg">
          <span className="sr-only" aria-live="polite">
            {pin.length} of 6 digits entered
          </span>
          <div className="flex justify-center gap-2" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <motion.div
                key={i}
                className="w-10 h-10 rounded-lg bg-relay-surface-hover border border-relay-border-light flex items-center justify-center font-mono text-sm font-bold"
                animate={
                  i < pin.length
                    ? { scale: 1, backgroundColor: '#7F77DD', borderColor: '#7F77DD' }
                    : { scale: 1 }
                }
                transition={{ duration: 0.1 }}
              >
                {i < pin.length && (
                  <span className="text-white">●</span>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* PIN Pad Grid */}
      <motion.div className="grid grid-cols-3 gap-3">
        {PIN_BUTTONS.map((digit) => (
          <motion.button
            key={digit}
            type="button"
            onClick={() => handleDigit(digit)}
            disabled={isLoading || (digit === 'enter' && pin.length !== 6)}
            aria-label={getButtonLabel(digit)}
            className={`
              h-14 rounded-xl font-bold text-lg transition-all duration-150
              ${getButtonColor(digit)}
              disabled:opacity-50 disabled:cursor-not-allowed
              active:scale-95
            `}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <span aria-hidden="true">
              {digit === 'backspace' ? '⌫' : digit === 'enter' ? '✓' : digit}
            </span>
          </motion.button>
        ))}
      </motion.div>

      {/* Enter button hint */}
      <div className="text-center text-xs text-relay-text-muted flex items-center justify-center gap-2">
        <Lock size={12} aria-hidden="true" />
        Press ✓ to confirm
      </div>
    </motion.div>
  );
};
