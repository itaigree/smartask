'use client';

import { useLayoutEffect, useRef } from 'react';
import { useCloseOnBack } from './useCloseOnBack.ts';

/**
 * A sheet that slides up from the bottom — the natural reach on a phone — for
 * a choice about one task: its category, its reminder.
 *
 * It is a real modal `<dialog>`: while it is open, Tab and screen readers stay
 * inside it, and the board behind cannot be reached.
 */
export default function Sheet({
  label,
  heading,
  taskTitle,
  returnFocusTo,
  onClose,
  children,
}: {
  /** The dialog's accessible name. */
  label: string;
  heading: string;
  /** The task the sheet is about, shown under the heading. */
  taskTitle: string;
  /**
   * A selector for the control to focus when the sheet closes and the one that
   * opened it is gone — the task's card may have been re-drawn elsewhere.
   */
  returnFocusTo: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDialogElement>(null);

  // Android's back gesture closes the sheet, not the app.
  useCloseOnBack(true, onClose);

  // Runs once, when the sheet opens — not again on later renders. The board
  // re-renders all the time (the minute tick, a finished save, each step of a
  // sort), and focusing the sheet then would pull focus out of a field inside
  // it and close the phone's keyboard.
  const fallback = useRef(returnFocusTo);
  useLayoutEffect(() => {
    const sheet = sheetRef.current!;
    const opener = document.activeElement;
    sheet.showModal();
    sheet.focus();
    return () => {
      if (sheet.open) sheet.close();
      // Focus goes back to the control that opened the sheet. If the change
      // re-drew its card in another group, that control is gone: use the new one.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const target =
          opener instanceof HTMLElement && opener.isConnected
            ? opener
            : document.querySelector<HTMLElement>(fallback.current);
        target?.focus();
      });
    };
  }, []);

  /** A tap on the dimmed area: it belongs to the dialog, but lies outside its box. */
  function onBackdrop(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) onClose();
  }

  return (
    <dialog
      className="sheet"
      aria-label={label}
      tabIndex={-1}
      ref={sheetRef}
      onClick={onBackdrop}
      // Escape, or the back gesture where the browser hands it to the dialog.
      // The board decides when the sheet goes, so the browser's own close waits.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="panel-head">
        <h2>{heading}</h2>
        <button type="button" className="icon-button" onClick={onClose}>
          cancel
        </button>
      </div>
      <p className="sheet-task" dir="auto">
        {taskTitle}
      </p>
      {children}
    </dialog>
  );
}
