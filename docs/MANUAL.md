# Manual de LevelUp Store

Guía para operar la tienda desde el panel. No necesitas saber nada técnico ni
llamar a nadie para hacer cualquier cosa de aquí.

El panel está en tu dominio de administración y entras con tu correo y
contraseña. La tienda que ven los clientes es el dominio principal.

---

## Lo primero, antes de vender

Entra a **Ajustes** y captura tu cuenta bancaria.

Esto es lo único que, si falta, detiene **todas** las ventas. Mientras no esté
configurado, el cliente no ve dónde depositar: en su lugar aparece un aviso
para que te escriba por WhatsApp, y en el panel verás una barra roja.

Al guardar, el sistema revisa que la CLABE sea válida de verdad (verifica su
dígito de control). Si te equivocaste en un número, te avisa en ese momento —
no cuando un cliente intente pagarte y su transferencia rebote.

El número de OXXO es opcional. Si lo dejas vacío, esa línea simplemente no
aparece en la tienda.

---

## El día a día

### Aprobar pagos

**Aprobaciones** es la pantalla que más vas a usar.

Cada pedido pagado aparece con su comprobante. Ábrelo y revisa dos cosas:

1. Que el monto coincida **exactamente** con el precio del paquete.
2. Que el depósito sea a tu cuenta.

Si todo está bien, aprueba. Ahí mismo arranca la recarga automáticamente: no
tienes que hacer nada más.

Si el monto no coincide, no apruebes. Escríbele al cliente primero. Una vez
aprobado, los diamantes se envían y **no se pueden recuperar**.

### Registrar una venta de WhatsApp

Si alguien te compró por WhatsApp y ya te pagó, ve a **Pedidos → Nuevo pedido
manual**.

Escribe el ID de Free Fire, confirma que el nombre del personaje sea el
correcto, elige el paquete y marca que ya pagó. La recarga entra igual de
automático que si hubiera comprado en la página, y queda registrada igual.

Puedes usar esto aunque un combo esté apagado. Es a propósito: sirve para
cuando alguien pagó por una promoción que ya terminó.

### Revisar pedidos

**Pedidos** los lista todos. Puedes buscar por número de pedido o por ID de
jugador — que es justo lo que el cliente te va a mandar por WhatsApp.

El filtro **"Requieren atención"** es el importante. Ahí caen los pedidos donde
algo no salió limpio y hace falta que un humano decida.

---

## Cada mes

### Cambiar el flyer

**Combos → la promoción → subir imagen.**

Sube el mismo flyer que publicas en redes. Es la imagen que ve el cliente
arriba de los paquetes.

Los paquetes que se pueden comprar son tarjetas reales debajo del flyer, no
texto dentro de la imagen. Por eso, si cambias precios en el flyer, tienes que
cambiarlos también en los combos — la imagen sola no vende nada.

### Prender y apagar combos

**Combos → el combo → "Visible en la tienda".**

Si un combo entrega menos diamantes de los que anuncia, el sistema no te deja
prenderlo. No es un error: es para que nunca le prometas a un cliente algo que
no le vas a entregar.

### Programar una promoción

En cada promoción puedes poner fecha de inicio y de fin. Al pasar la fecha
final, la promoción y sus combos desaparecen solos de la tienda. No tienes que
acordarte de apagarlos.

---

## Testimonios

**Testimonios** es donde pones los comentarios que salen en la página de
Confianza.

Úsalos **reales**, tal como te los mandaron por WhatsApp. Tres datos por cada
uno: el comentario, el nombre y, si quieres, el paquete que compraron.

Si no hay ninguno cargado, esa sección no aparece. Eso es mejor que inventarlos:
tu página de Confianza existe para convencer a gente que ya la estafaron antes,
y en este mercado las reseñas inventadas se notan.

---

## Tipo de cambio

En **Ajustes** también está el tipo de cambio (pesos por dólar).

Sólo sirve para que el panel te muestre bien tus costos y tus ganancias.
**No cambia el precio que paga el cliente.** Tus precios son los que tú pones
en cada combo, en pesos.

Actualízalo de vez en cuando para que tus márgenes se vean reales.

---

## Cuando algo sale mal

### Un pedido dice "Requiere revisión"

Significa que el sistema no pudo estar seguro de si el proveedor ya cobró o no,
y prefirió no adivinar.

Entra al panel de RecargasAmérica, busca el movimiento por hora y monto, y:

- Si sí se hizo la recarga, marca el pedido como entregado.
- Si no se hizo, vuelve a intentarlo.

Nunca adivines. Los diamantes ya enviados no se pueden recuperar.

### Los pedidos pagados no se están entregando

Casi siempre es el saldo en RecargasAmérica.

El sistema **pausa todas las entregas** cuando el saldo no alcanza para
completar un pedido, en lugar de entregar pedidos a medias. Recarga tu saldo y
la cola sigue sola.

### Un cliente dice que pagó y no le llegó

Búscalo en **Pedidos** por su ID de jugador o número de pedido. El estado te
dice exactamente en qué punto está:

| Estado | Qué significa |
|---|---|
| Esperando pago | No hemos recibido su comprobante |
| Revisando pago | Ya subió comprobante, falta que tú lo apruebes |
| Procesando | Aprobado, los diamantes están entrando |
| Completado | Ya se entregaron |
| Requiere revisión | Algo falló, hay que atenderlo a mano |

### Las imágenes de los flyers no se ven

Avísale a tu desarrollador. Normalmente significa que el servidor perdió la
carpeta donde se guardan las imágenes.

---

## Cosas que conviene saber

- **Nunca pedimos la contraseña de Free Fire** a nadie, y la página lo dice.
  Es parte de por qué te compran.
- **El cliente confirma el nombre de su personaje antes de pagar.** Si se
  equivocó de ID y aun así confirmó, la recarga se va a esa cuenta y no hay
  forma de revertirla. Por eso los Términos lo dicen claro.
- **La oferta de $10 es una por cuenta de Free Fire.** El sistema lo bloquea
  solo; no tienes que revisarlo.
- **Los comprobantes de pago sólo se ven desde el panel**, con tu sesión
  iniciada. No son públicos ni se pueden abrir con una liga.

---

## Seguridad

- No compartas tu contraseña del panel con nadie. Si alguien más necesita
  entrar, pide una cuenta aparte.
- Si crees que alguien más entró, cambia la contraseña de inmediato.
- Cambia tu contraseña de RecargasAmérica cada cierto tiempo. Esa cuenta tiene
  saldo real.
