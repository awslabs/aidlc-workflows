# Transferencia de conocimiento — plugin `aws-mlops` de AI-DLC

Documento para entregar a un cliente que va a adoptar y/o extender el plugin
`aws-mlops`. Explica qué es, cómo encaja en el motor de AI-DLC, qué entrega,
cómo se instala y selecciona, y cómo se extiende sin romper el core.

---

## 1. Idea en una frase

`aws-mlops` es un **plugin de AI-DLC** (aditivo, versionado, propiedad del
equipo) que añade al motor dos líneas de producción para hacer MLOps sobre
**AWS SageMaker**:

- **`aws-mlops-platform`** — construir y poner en operación una plataforma
  MLOps reutilizable (entornos, identidad, almacenamiento de datos/artefactos,
  entrenamiento reproducible, registro y promoción de modelos, despliegue,
  monitoreo, reentrenamiento y recuperación).
- **`aws-mlops-crisp-mlq`** — desarrollar, desplegar y mantener un modelo
  concreto sobre esa plataforma usando la metodología **CRISP-ML(Q)**.

Clave para el cliente: **añadir el plugin al repositorio no aprovisiona nada en
AWS ni implementa un modelo**. El plugin aporta *instrucciones de flujo y
verificaciones*. Ejecutar esos flujos es lo que genera IaC, código y pipelines
del proyecto.

---

## 2. Cómo encaja en el motor de AI-DLC

Vale la pena fijar el vocabulario del motor antes de entrar al plugin, porque el
plugin se expresa enteramente en esos términos:

| Término | Qué es | En `aws-mlops` |
|---|---|---|
| **Scope** | Una línea de producción: qué estaciones recorre un tipo de trabajo y con qué profundidad | `aws-mlops-platform` (Comprehensive), `aws-mlops-crisp-mlq` (Standard) |
| **Stage** | Una estación del flujo: qué se produce, consume, verifica e instruye | 10 stages ML (ideation, inception, construction, operation) |
| **Agent** | El trabajador/persona de una estación, con su conocimiento de oficio | `data-scientist`, `ml-engineer` |
| **Contribution** | Modificación **aditiva** a un stage del core, sin editarlo | 13 overlays sobre stages de inception/construction/operation/initialization |
| **Sensor** | Verificación determinista del output de una estación (advisory por defecto) | 2 sensores de evidencia |
| **Knowledge** | Referencia metodológica que leen los agentes | CRISP-ML(Q) local + knowledge por agente |
| **Tool** | CLI TypeScript determinista que posee estructura exacta | catálogo de metodologías, mapeo de fases, scripts de sensores |

Principios que el plugin respeta por diseño (son los del mecanismo de plugins):

- **Estrictamente aditivo, nunca sobrescribe.** Las contribuciones solo *suman*.
  Dos plugins que tocan el mismo stage se fusionan (unión de conjuntos), no se
  pisan.
- **El core es inmutable.** Ningún archivo bajo `core/` se edita; todo lo que
  aporta el plugin vive en su propio árbol.
- **Reversible e inerte si está apagado.** Deshabilitar el plugin recompone el
  install exactamente como si no estuviera, pero los archivos quedan instalados
  y re-habilitables.
- **El slug es la identidad.** Los stages se identifican por slug; el `number`
  es solo para orden/visualización, así que insertar un stage del plugin no
  renumera el core.

---

## 3. Estructura del plugin

```text
plugins/aws-mlops/
  .aidlc-plugin/plugin.json          # manifiesto declarativo
  README.md                          # guía de build/instalación/arranque
  agents/                            # 2 personas (data-scientist, ml-engineer)
  contributions/                     # overlays aditivos a stages del core
    initialization/ inception/ construction/ operation/
  knowledge/
    aidlc-shared/                    # CRISP-ML(Q) local + aws-mlops.md
    aws-mlops-<role>-agent/          # metodología por persona
  scopes/                            # 2 scopes (platform, crisp-mlq)
  sensors/                           # 2 manifiestos de sensor (advisory)
  stages/                            # 10 stages ML por fase
    ideation/ inception/ construction/ operation/
  tools/                             # catálogo, mapeo de fases, scripts de sensor
  tests/                             # validación de contenido (nivel integración)
```

El manifiesto `plugin.json` es declarativo y mínimo. Lo esencial:

```json
{
  "name": "aws-mlops",
  "version": "0.1.0",
  "dependencies": ["core"],
  "aidlc": {
    "contributes": {
      "stages": "stages/", "overlays": "contributions/",
      "agents": "agents/", "scopes": "scopes/",
      "knowledge": "knowledge/", "sensors": "sensors/", "tools": "tools/"
    }
  }
}
```

Nota: `overlays` es el nombre en el manifiesto para la carpeta canónica
`contributions/`; el motor la consume en el *merge*, no la copia.

---

## 4. Los dos scopes (rutas de trabajo)

### `aws-mlops-platform` (profundidad: Comprehensive)

Construir la plataforma compartida **una vez**. Ruta:

> Initialization → selección de metodología → arquitectura de plataforma →
> requisitos/diseño/implementación/CI del core → validación de plataforma →
> CD y aprovisionamiento de entornos → commissioning → monitoreo y mantenimiento.

Límite importante: un *commissioning fixture* prueba el camino de
infraestructura; **no es un modelo de negocio ni evidencia de calidad
predictiva**. Para eso se sigue con el otro scope.

### `aws-mlops-crisp-mlq` (profundidad: Standard)

Desarrollar, desplegar y mantener un modelo con CRISP-ML(Q). Ruta:

> Initialization → selección → entendimiento de negocio/datos → ajuste a la
> plataforma → requisitos e implementación del core → diseño de ciclo de vida →
> preparación de datos → modelado → evaluación → validación de CD/entornos →
> despliegue → monitoreo y mantenimiento.

Depende de la plataforma commissionada por `aws-mlops-platform`, o de
infraestructura AWS equivalente que aporte la persona. Las fases CRISP-ML(Q)
son: *business/data understanding → data preparation → modeling → evaluation →
deployment → monitoring/maintenance*, con *quality and risk assessment* a lo
largo de todas.

Ambos scopes comparten estos flags de frontmatter: `runner: true`,
`guard_policy: off`, `sensors: on`, `plan_approval: on`,
`summary_confirmation: on`, `skeleton: on`.

---

## 5. Los agentes (quién hace el trabajo)

- **Data Scientist** (`aws-mlops-data-scientist-agent`, tier `judgment`) —
  entendimiento de negocio/datos, prevención de fuga de datos (leakage),
  baselines, experimentos reproducibles y evaluación. Trae opciones para las
  preguntas científicas; la persona decide valor de negocio, tolerancias y
  tradeoffs.
- **ML Engineer** (`aws-mlops-ml-engineer-agent`, tier `judgment`) — pipelines
  reproducibles de SageMaker (Processing, Training, Pipelines, Model Registry),
  promoción en el registro, inferencia (batch/async/real-time según la carga),
  idempotencia, límites de concurrencia y costo, recuperación, y monitoreo/
  reentrenamiento que corren **dentro de AWS**.

Regla de oro que ambos comparten: **nunca convertir una verificación offline en
afirmación de ejecución en AWS, ni fabricar ARNs, métricas o aprobaciones.** El
conocimiento de ML general selecciona técnicas, pero no reemplaza el método
documentado ni las decisiones de negocio de la persona.

Los agentes no se llaman entre sí: solo el conductor reparte el trabajo.

---

## 6. Metodología: CRISP-ML(Q) como referencia local

Pieza central para el cliente, porque es donde el plugin garantiza rigor
metodológico sin depender de que el modelo "recuerde" CRISP-ML(Q):

- La referencia vive en `knowledge/aidlc-shared/aws-mlops-crisp-mlq.md`,
  **revisión 1.0.0**, con trazabilidad a la publicación original (Studer et al.,
  2021, DOI `10.3390/make3020020`, CC BY 4.0). Es una **adaptación operativa**
  del artículo, no su texto completo ni un estándar de conformidad oficial.
- El agente **lee la referencia al inicio de cada stage de modelo** (incluido un
  stage reanudado). Si no está disponible, debe declararlo y restaurarla antes
  de hacer afirmaciones metodológicas. No puede reconstruir el método "de
  memoria" ni cambiar silenciosamente de metodología.
- El **quality loop** se aplica en cada fase (no solo en la evaluación final):
  1. identificar requisitos/constraints de la fase (con versión),
  2. describir el trabajo y sus condiciones de ejecución,
  3. identificar modos de fallo de la tarea (riesgo),
  4. elegir mitigación + dueño + evidencia que la demuestre,
  5. comparar evidencia con los criterios (met/failed/pending/justificado).
- `tools/aws-mlops-crisp-mlq.ts` **posee el mapeo versionado fase→evidencia**
  (20 requisitos derivados de la publicación). Cada fase de modelo escribe un
  registro de cobertura `.crisp-mlq.json` adyacente al artefacto Markdown.

La selección de metodología es un stage propio (`aws-mlops-methodology-selection`)
que lee el catálogo `tools/aws-mlops-methodologies.ts`, explica métodos
disponibles vs. planificados en el idioma de la persona, y **registra la
elección real de la persona**. Una recomendación del agente o un default **no**
es una elección. CRISP-ML(Q) es el método implementado; CRISP-DM, TDSP, SEMMA y
KDD están como roadmap (visibles pero no enrutados como si fueran CRISP-ML(Q)).

---

## 7. Sensores (verificación determinista, advisory)

Dos sensores, ambos `default_severity: advisory`, `fire_on: gate`, **sin
llamadas de red ni a AWS**:

- **`aws-mlops-crisp-mlq`** — valida la cobertura de fases CRISP-ML(Q): lee el
  `.crisp-mlq.json` adyacente usando el mapeo de `tools/aws-mlops-crisp-mlq.ts`,
  verifica revisión de referencia, requisitos de fase, estado de evidencia y el
  registro de riesgo/calidad. Las fases de plataforma (deployment/monitoring)
  escriben un registro de exención `profile: platform` que el sensor acepta como
  no-aplicabilidad del contrato de modelo de negocio.
- **`aws-mlops-evidence`** — chequea el JSON de elección contra el catálogo y los
  umbrales numéricos de evaluación.

Qué dejar claro al cliente: los sensores **verifican registros y consistencia
numérica, no la verdad metodológica ni la ejecución en AWS**. El motor sigue
siendo el dueño de las aprobaciones humanas; un sensor advisory reporta trabajo
faltante pero no bloquea, y un *skip* explícito de la persona se registra con el
mecanismo del motor.

---

## 8. La contribución al stage `build-and-test` (ejemplo real)

El archivo `contributions/construction/build-and-test.md` es un ejemplo perfecto
del **contribution seam**. Modifica aditivamente el stage del core
`build-and-test` **sin editarlo**:

```yaml
---
target: build-and-test        # stage del core que se enriquece
plugin: aws-mlops
adds:
  scopes: [aws-mlops-platform, aws-mlops-crisp-mlq]
  consumes:
    - artifact: aws-mlops-lifecycle-design
      required: true
  requires_stage: [aws-mlops-lifecycle-design]
fragments:
  - anchor: before-step:1
    order: 100
---

## fragment: before-step:1
### AWS MLOps context
...prosa que se inserta antes del Step 1 del stage, solo cuando el
   scope activo es aws-mlops-platform o aws-mlops-crisp-mlq...
```

Cómo interpretarlo:

- El bloque `adds:` son **superficies estructurales** que se **unen por conjunto**
  al frontmatter del stage destino (scopes, consumes, requires_stage). Esto es
  conmutativo y seguro entre autores independientes.
- Los `fragments:` son **prosa** que se inserta en un *anchor* del cuerpo del
  stage (`before-step:1`) con un `order` para desempatar. Aquí añade la
  instrucción de mapear cada contrato del ciclo de vida a verificación
  significativa, usar fixtures locales y *stubs* de AWS, y **registrar aparte**
  los chequeos cloud no ejecutados.
- La prosa misma condiciona: "aplica solo cuando el scope activo es
  `aws-mlops-platform` o `aws-mlops-crisp-mlq`; otros flujos conservan su
  comportamiento". Eso es lo que hace al overlay inofensivo para instalaciones
  que no usan MLOps.

---

## 9. Build, instalación y selección

### Build y verificación (desde el checkout fuente de AI-DLC)

```bash
bun core/tools/aidlc-plugin-validate.ts plugins/aws-mlops --json
bun scripts/package.ts
bun scripts/package.ts --check          # byte-identical entre dos builds limpios
bun test plugins/aws-mlops/tests
bun core/tools/aidlc-plugin-test.ts plugins/aws-mlops \
  --install dist/kiro --harness kiro --json
```

El packager emite las **siete proyecciones de harness** en
`dist/plugins/aws-mlops/<harness>/`. Esas proyecciones **no son fuente**: no se
editan ni se commitean; se regeneran.

### Selección en el proyecto destino

Plugins *añaden*; el install *selecciona*. Tras componer el plugin en el
proyecto:

```bash
aidlc engine plugin select aidlc,aws-mlops
```

Preservar en esa lista los nombres de otros plugins habilitados. `aidlc` es el
plugin núcleo implícito. Si la clave `plugins` de `harness.json` está ausente,
todos los plugins instalados quedan habilitados.

### Arranque de un flujo (en Kiro)

En Kiro (IDE o CLI) el entrypoint es `/aidlc` dentro del chat. Primero el scope
de plataforma:

```text
/aidlc aws-mlops-platform
Construir una plataforma MLOps nueva en AWS SageMaker usando CRISP-ML(Q).
```

Tras poner en operación la plataforma, iniciar un intent de modelo:

```text
/aidlc aws-mlops-crisp-mlq
Desarrollar <problema de negocio> usando la plataforma <referencia>.
```

Estos ejemplos inician flujos desde el chat; no son comandos de shell. En Kiro
CLI se arranca con `kiro-cli chat` desde la raíz del proyecto y `/aidlc` queda
activo sin flag de agente. AI-DLC en Kiro funciona mejor con **Claude Opus 4.8**
(requiere plan de pago de Kiro).

---

## 10. Límites operativos que el cliente debe entender

- **Local ≠ AWS.** Compilación de SDK, synth de IaC y fixtures son distintos de
  ejecuciones reales en AWS. Afirmaciones de runtime requieren referencias y
  métricas reales de experimento/registro/inferencia.
- **Monitoreo con verdad de campo.** Se distingue drift, salud del servicio y
  calidad del modelo contra ground truth. El reentrenamiento recurrente corre en
  servicios de AWS, independiente de la conversación con la IA.
- **Greenfield.** AWS cierra actualmente Model Monitor y Clarify a clientes
  nuevos. Para un cliente nuevo no se exige ninguno de los dos; el diseño inicial
  soporta análisis in-account con Processing/open-source más CloudWatch, S3 y
  EventBridge. Verifica la disponibilidad regional/por-cliente vigente al
  implementar.
- **Checks con modelos reales (opcional, gastan tokens):**
  `AIDLC_MLOPS_LIVE=1 bun test plugins/aws-mlops/tests/crisp-mlq-live.test.ts`
  usa la autenticación y el proveedor existentes de tu CLI, no contacta
  SageMaker, y guarda reportes/transcripts bajo
  `tests/logs/aws-mlops-methodology/`. En Kiro el modelo recomendado es Claude
  Opus 4.8 (plan de pago).

---

## 11. Cómo extender el catálogo de metodologías

Pasos recomendados (del README del plugin):

1. Autorar el flujo y entregables del método, preservando su significado real.
2. Mapear contratos compartidos de datos, entrenamiento, release y mantenimiento
   a stages reutilizables.
3. Añadir el scope *namespaced* y su membresía/contribuciones.
4. Añadir knowledge específico del método y validación significativa.
5. Marcar la entrada del catálogo como `available` **solo** cuando pasen las
   pruebas de composición y de ruta.

Regla dura: **la plataforma compartida no se duplica por método.** Perfiles como
SEMMA/KDD deben etiquetar explícitamente los pasos de negocio/despliegue/
operación que añaden para producción.

---

## 12. Mapa rápido de archivos para onboarding

Rutas relativas a este archivo (`plugins/aws-mlops/docs/knowledge-transfer.md`).

| Quiero entender… | Mira… |
|---|---|
| Qué entrega el plugin y cómo arrancar | `../README.md` |
| Las dos rutas de trabajo | `../scopes/aws-mlops-platform.md`, `../scopes/aws-mlops-crisp-mlq.md` |
| Cómo se elige la metodología | `../stages/ideation/aws-mlops-methodology-selection.md` |
| La metodología CRISP-ML(Q) | `../knowledge/aidlc-shared/aws-mlops-crisp-mlq.md` |
| El mapeo fase→evidencia | `../tools/aws-mlops-crisp-mlq.ts` |
| Cómo se enriquecen stages del core | cualquier archivo en `../contributions/` |
| Las personas que trabajan los stages | `../agents/aws-mlops-*-agent.md` |
| Cómo funciona el mecanismo de plugins | `../../../docs/reference/18-plugin-mechanism.md` |
| Guía de autoría de plugins | `../../../docs/harness-engineering/10-authoring-a-plugin.md` |
| Guía de usuario del plugin | `../../../docs/guide/aws-mlops.md` |
