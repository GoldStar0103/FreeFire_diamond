'use client';

import { useEffect, useState } from 'react';
import logo from '../../../assets/logo.webp';
import vipMascot from '../../../assets/mascot/vip-popup.webp';
import { BellIcon, CrownIcon, GiftIcon, PercentIcon, WhatsAppIcon } from '../../icons';

const STORAGE_PREFIX = 'levelup_vip_popup_dismissed:';

/**
 * VIP WhatsApp group invite after a completed top-up.
 *
 * Jose's ask: one popup, only when diamonds are already delivered — never on
 * processing / waiting / failed orders. The invite URL still comes from
 * WHATSAPP_VIP_GROUP_URL (see vip.ts); if that env is unset, the parent does
 * not mount this component at all.
 */
export function VipGroupPopup({ groupUrl, orderNumber }: { groupUrl: string; orderNumber: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const key = STORAGE_PREFIX + orderNumber;
    try {
      if (sessionStorage.getItem(key) === '1') return;
    } catch {
      /* Private browsing — still show. */
    }
    const timer = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(timer);
  }, [orderNumber]);

  if (!visible) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(STORAGE_PREFIX + orderNumber, '1');
    } catch {
      /* No storage — it just shows again next visit. */
    }
    setVisible(false);
  };

  return (
    <div className="vip-popup-overlay" role="dialog" aria-modal="true" aria-labelledby="vip-popup-title">
      <div className="vip-popup">
        <button type="button" className="vip-popup-close" aria-label="Cerrar" onClick={dismiss}>
          ✕
        </button>

        <div className="vip-popup-mascot" aria-hidden="true">
          <img src={vipMascot.src} alt="" width={vipMascot.width} height={vipMascot.height} />
        </div>

        <div className="vip-popup-body">
          <img className="vip-popup-logo" src={logo.src} width={40} height={40} alt="LevelUp Store" />

          <h2 id="vip-popup-title" className="vip-popup-title">
            Únete a nuestro
            <span>
              Grupo VIP <CrownIcon className="icon" />
            </span>
          </h2>

          <p className="vip-popup-lead">Recibe antes que nadie:</p>

          <ul className="vip-popup-benefits">
            <li>
              <span className="vip-popup-benefit-icon" aria-hidden="true">
                <PercentIcon className="icon" />
              </span>
              Promociones exclusivas
            </li>
            <li>
              <span className="vip-popup-benefit-icon" aria-hidden="true">
                <BellIcon className="icon" />
              </span>
              Nuevos top ups y ofertas
            </li>
            <li>
              <span className="vip-popup-benefit-icon" aria-hidden="true">
                <GiftIcon className="icon" />
              </span>
              Códigos, eventos y sorpresas
            </li>
          </ul>

          <a
            href={groupUrl}
            target="_blank"
            rel="noreferrer"
            className="btn wide vip-popup-cta"
            onClick={dismiss}
          >
            <WhatsAppIcon className="icon" /> Unirme al Grupo VIP →
          </a>

          <button type="button" className="vip-popup-later" onClick={dismiss}>
            Ahora no
          </button>
        </div>
      </div>
    </div>
  );
}
