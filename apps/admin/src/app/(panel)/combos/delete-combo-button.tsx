'use client';

import type { FormEvent } from 'react';
import { deleteCombo } from './actions';

interface Props {
  comboKey: string;
  comboName: string;
}

/** A combo, once deleted, is gone — this only removes it from the sale list, past orders keep their record. */
export function DeleteComboButton({ comboKey, comboName }: Props) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!window.confirm(`¿Eliminar "${comboName}"? Esto no se puede deshacer.`)) {
      event.preventDefault();
    }
  };

  return (
    <form action={deleteCombo} onSubmit={onSubmit}>
      <input type="hidden" name="comboKey" value={comboKey} />
      <button className="btn sm danger" type="submit" title="Eliminar combo">
        Eliminar
      </button>
    </form>
  );
}
