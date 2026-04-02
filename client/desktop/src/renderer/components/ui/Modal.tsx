import React, { useContext, useEffect, useId, useRef } from 'react';
import { ModalDepthContext, useModalStack } from './ModalContext';
import './Modal.css';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: 'small' | 'medium' | 'large';
}

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, width = 'medium' }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalId = useId();
  const depth = useContext(ModalDepthContext);
  const { register, unregister, isTopmost } = useModalStack();

  useEffect(() => {
    if (!isOpen) return;

    register(modalId, depth);
    return () => unregister(modalId);
  }, [isOpen, modalId, depth, register, unregister]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopmost(modalId)) {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, modalId, isTopmost]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current && isTopmost(modalId)) {
      e.stopPropagation();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <ModalDepthContext.Provider value={depth + 1}>
      <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
        <div className={`modal-container modal-${width}`}>
          <div className="modal-header">
            <h3 className="modal-title">{title}</h3>
            <button className="modal-close" onClick={onClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <div className="modal-body">{children}</div>
        </div>
      </div>
    </ModalDepthContext.Provider>
  );
};

export default Modal;
