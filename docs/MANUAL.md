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

### Pagos con tarjeta (Stripe)

Cuando Stripe está activado, el cliente ve dos opciones al pagar:
**💳 Tarjeta** y **🏦 Transferencia**. La transferencia con comprobante sigue
funcionando igual que siempre.

Si paga con tarjeta, **no tienes que aprobar nada**. Stripe nos avisa en cuanto
el banco acepta el cobro y la recarga arranca sola, normalmente en segundos.
Esos pedidos **no aparecen en Aprobaciones** porque no hay comprobante que
revisar: el comprobante es el propio cobro en Stripe.

En el detalle del pedido verás "Tarjeta u OXXO (Stripe)" y una referencia que
empieza con `pi_`. Al darle clic se abre ese cobro en tu panel de Stripe, que
es donde se atienden aclaraciones o devoluciones.

Si activaste OXXO en Stripe, el cliente también puede pagar en efectivo: Stripe
le da una ficha, la paga en cualquier OXXO, y cuando Stripe confirma el pago
(puede tardar unas horas) la recarga entra sola. Si no la paga, el pedido se
vence solo.

**Si te llega una alerta "Pago con tarjeta recibido pero NO aprobado"**: alguien
pagó pero el sistema no pudo aprobarlo solo — por ejemplo, el pedido ya se había
vencido. Revisa el cobro en Stripe. Si el cliente sí debe recibir su recarga,
créale un **pedido manual** (Pedidos → Nuevo pedido manual) marcado como pagado.
Si no, devuélvele el dinero desde Stripe.

**Devoluciones:** se hacen desde el panel de Stripe. Recuerda que si los
diamantes ya se entregaron, no se pueden recuperar.

### Registrar una venta de WhatsApp

Si alguien te compró por WhatsApp y ya te pagó, ve a **Pedidos → Nuevo pedido
manual**.

Escribe el ID de Free Fire, confirma que el nombre del personaje sea el
correcto, elige el paquete y marca que ya pagó. La recarga entra igual de
automático que si hubiera comprado en la página, y queda registrada igual.

Puedes usar esto aunque un combo esté apagado. Es a propósito: sirve para
cuando alguien pagó por una promoción que ya terminó.

### Pedidos que nadie pagó

Un pedido que se queda esperando pago **se vence solo a las 48 horas** y pasa a
"Pago vencido". No tienes que hacer nada.

Esto importa por la oferta de $10: como es una por cuenta de Free Fire, un
intento que quedó a medias bloqueaba al cliente para siempre. Al vencerse, su
lugar se libera y puede volver a intentarlo.

Un pedido con comprobante subido **nunca se vence** — ése ya te pagó y está
esperando que tú lo apruebes. Y si un pedido ya aparece como "Pago vencido" pero
resulta que el cliente sí había pagado, créale un **pedido manual** (Pedidos →
Nuevo pedido manual) marcado como pagado: el pedido vencido ya no se puede
aprobar, y el manual entrega exactamente igual.

### Revisar pedidos

**Pedidos** los lista todos. Puedes buscar por número de pedido o por ID de
jugador — que es justo lo que el cliente te va a mandar por WhatsApp.

El filtro **"Requieren atención"** es el importante. Ahí caen los pedidos donde
algo no salió limpio y hace falta que un humano decida.

---

## Temporadas, Level Pass y La Bóveda

El Level Pass, el ranking público y La Bóveda viven dentro de una temporada
de 60 días. **Hasta que inicies la primera, esas tres cosas están apagadas
en la tienda.**

### Iniciar una temporada

**Temporadas → Iniciar Temporada 1 (60 días).**

Hay que hacerlo una vez para arrancar. Al cerrarse sola a los 60 días puedes
iniciar la siguiente desde la misma pantalla.

### Checkpoints del Level Pass

En esa misma pantalla está la tabla de checkpoints: cuántos puntos (LP) hacen
falta, cuántos diamantes se entregan, el costo interno y **la receta de
entrega** (qué recargas del proveedor se mandan).

La receta empieza vacía a propósito, para no inventar números. Si un
checkpoint no tiene receta, esa recompensa no se puede entregar. Agrégala
con los botones de denominación (+ 100, + 310, etc.) y guarda.

Cambiar un checkpoint no toca recompensas que ya se entregaron.

### La Bóveda

**La Bóveda** son ofertas con descuento que solo ve quien ya completó el
Level Pass. Elige un combo activo, ponle el precio de Bóveda y actívala.
Hasta 6 activas a la vez.

### Insignias

**Insignias** son las medallas del ranking y del Level Pass. Las de ranking y
Level Pass se otorgan solas; las demás (por ejemplo "Fundador") se otorgan a
mano desde la página de cada una.

### Cuentas de cliente (Mi LevelUp)

Los jugadores entran a **Mi LevelUp** en la tienda con su **correo**: piden
un código, lo escriben, y si es la primera vez también ponen su ID de Free
Fire. El WhatsApp del checkout sigue siendo solo para contactarlos.

Los códigos los manda el sistema por correo. Si alguien te dice que no le
llegó el código, avísale a tu desarrollador — casi siempre es el buzón de
envío.

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
y prefirió no adivinar. Te llega una alerta por Telegram con el número de pedido.

Abre el pedido en el panel. Arriba aparece el recuadro **"Resolver este pedido"**
con cada recarga pendiente, su monto y la hora en que se envió.

1. Entra al panel de RecargasAmérica y busca cada una por **hora y monto**.
2. Por cada recarga:
   - Si la encontraste y sí se hizo: **✅ Sí llegó**.
   - Si no aparece ni se cobró: marca la casilla *"Revisé en RecargasAmérica y
     NO se cobró"* y presiona **↩ No llegó**.
3. Cuando ya no quede ninguna "Sin confirmar", presiona **Reanudar entregas**:
   se envían solas las recargas que falten.

Si todas quedan como entregadas, el pedido se completa solo.

**Nunca adivines.** Si marcas "No llegó" en una recarga que sí se había
cobrado, el cliente recibe doble y los diamantes no se pueden recuperar. Por eso
el sistema te pide confirmarlo.

**Si el pedido se pausó por falta de saldo:** recarga tu saldo en
RecargasAmérica y presiona **Reanudar entregas**. No hay nada más que revisar.

**Si no se puede entregar** (por ejemplo, la cuenta del cliente está
suspendida): abre *"No se puede entregar — marcar para reembolso"*, escribe el
motivo y confirma. Cuando le devuelvas el dinero, registra cómo lo hiciste con
**Reembolso hecho** y el pedido queda cerrado.

Todo lo que hagas aquí queda registrado con tu usuario.

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
| Esperando pago | No hemos recibido su comprobante, o su pago con tarjeta u OXXO no se ha confirmado |
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
- **El Píxel de Meta** registra solo las visitas y las compras de la tienda
  para que tus anuncios de Facebook e Instagram sepan qué funciona. Cada compra
  pagada se le reporta a Meta una sola vez, aunque el cliente recargue la
  página. En Meta, las compras aparecen en el Administrador de eventos.

---

## Seguridad

- No compartas tu contraseña del panel con nadie. Si alguien más necesita
  entrar, pide una cuenta aparte.
- Si crees que alguien más entró, cambia la contraseña de inmediato.
- Cambia tu contraseña de RecargasAmérica cada cierto tiempo. Esa cuenta tiene
  saldo real.

### Verificación en dos pasos (2FA)

Además de la contraseña, puedes pedir un código de 6 dígitos generado por una
app en tu teléfono (Google Authenticator, Authy, 1Password o cualquier app de
autenticación) cada vez que alguien inicie sesión en el panel. Es la misma
protección que usan los bancos: aunque alguien adivine o robe tu contraseña,
no puede entrar sin tu teléfono.

**Para activarla:**

1. Entra a **Ajustes** y busca "Verificación en dos pasos".
2. Pulsa **Activar**. Verás una clave y una liga; escanéala o escribe la clave
   en tu app de autenticación.
3. Escribe el código de 6 dígitos que te muestra la app y confirma. Solo se
   activa cuando ese primer código es correcto — así no te quedas afuera por
   haber escaneado mal.

A partir de ese momento, cada inicio de sesión te pedirá el código además de
la contraseña.

**Si pierdes el teléfono:** si todavía puedes entrar al panel, desactívala
desde Ajustes (te pedirá tu contraseña otra vez) antes de cambiar de teléfono.
Si ya no puedes entrar porque no tienes cómo generar el código, no hay forma
de saltarte este paso tú mismo — es justo lo que lo hace seguro. Pide al
desarrollador que la desactive desde el servidor; es el mismo procedimiento
que ya existe para restablecer una contraseña olvidada (ver
[RUNBOOK.md](RUNBOOK.md)), y de hecho ese mismo restablecimiento también
apaga la verificación en dos pasos, para que no te quedes con la puerta cerrada
dos veces.
