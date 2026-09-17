type PaypalSdkOptions = {
  clientId: string
  currency: string
}

type PaypalCardFieldTargets = {
  name: HTMLElement
  number: HTMLElement
  expiry: HTMLElement
  cvv: HTMLElement
}

type PaypalCardFieldsOptions = {
  paypal: any
  targets: PaypalCardFieldTargets
  createOrder: () => string | Promise<string>
  onApprove: (data: any) => void | Promise<void>
}

// PayPal's browser SDK is loaded on demand and cached by client/currency. The
// cache key matters because changing either value requires a new SDK instance.

declare global {
  interface Window {
    paypal?: any
    __petWoolPaypalSdkKey?: string
    __petWoolPaypalSdkPromise?: Promise<any>
  }
}

export function clearPaypalContainer(element?: HTMLElement | null) {
  if (element) element.innerHTML = ''
}

export async function loadPaypalSdk({ clientId, currency }: PaypalSdkOptions) {
  const normalizedClientId = String(clientId || '').trim()
  const normalizedCurrency = String(currency || 'USD').trim().toUpperCase()
  if (!normalizedClientId) throw new Error('paypal client id missing')
  const key = `${normalizedClientId}|${normalizedCurrency}`
  if (window.paypal && window.__petWoolPaypalSdkKey === key) return window.paypal
  if (window.__petWoolPaypalSdkPromise && window.__petWoolPaypalSdkKey === key) return window.__petWoolPaypalSdkPromise

  document.querySelectorAll('script[data-pet-wool-paypal-sdk="true"]').forEach((script) => script.remove())
  window.paypal = undefined
  window.__petWoolPaypalSdkKey = key
  const promise = new Promise<any>((resolve, reject) => {
    const script = document.createElement('script')
    const params = new URLSearchParams({
      'client-id': normalizedClientId,
      currency: normalizedCurrency,
      intent: 'capture',
      components: 'buttons,card-fields',
    })
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`
    script.async = true
    script.dataset.petWoolPaypalSdk = 'true'
    script.onload = () => window.paypal ? resolve(window.paypal) : reject(new Error('paypal sdk unavailable'))
    script.onerror = () => reject(new Error('paypal sdk failed'))
    document.head.appendChild(script)
  })
  window.__petWoolPaypalSdkPromise = promise
  try {
    return await promise
  } catch (error) {
    // A transient CDN, ad-blocker, or network failure must not poison all
    // subsequent payment attempts until the customer reloads the page.
    if (window.__petWoolPaypalSdkKey === key) {
      window.__petWoolPaypalSdkKey = undefined
      window.__petWoolPaypalSdkPromise = undefined
      window.paypal = undefined
    }
    document.querySelectorAll('script[data-pet-wool-paypal-sdk="true"]').forEach((script) => script.remove())
    throw error
  }
}

export function cardFieldsEligible(paypal: any) {
  return Boolean(paypal?.CardFields && paypal.CardFields().isEligible?.())
}

// Card fields are optional: PayPal may report them as ineligible by region or
// account configuration, while the standard PayPal button remains available.
export async function renderPaypalCardFields({ paypal, targets, createOrder, onApprove }: PaypalCardFieldsOptions) {
  if (!cardFieldsEligible(paypal)) return null
  const cardFields = paypal.CardFields({
    createOrder,
    onApprove,
  })
  const nameField = cardFields.NameField?.()
  const numberField = cardFields.NumberField?.()
  const expiryField = cardFields.ExpiryField?.()
  const cvvField = cardFields.CVVField?.()
  if (!nameField || !numberField || !expiryField || !cvvField || !cardFields.submit) return null
  await Promise.all([
    nameField.render(targets.name),
    numberField.render(targets.number),
    expiryField.render(targets.expiry),
    cvvField.render(targets.cvv),
  ])
  return cardFields
}
