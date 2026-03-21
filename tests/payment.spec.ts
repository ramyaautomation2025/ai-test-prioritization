import { test, expect } from '@playwright/test';

test.describe('Payment Summary Module @critical', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();
    await expect(page).toHaveURL(/inventory/);
    await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
    await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
    await page.locator('.shopping_cart_link').click();
    await page.locator('[data-test="checkout"]').click();
    await page.locator('[data-test="firstName"]').fill('Jane');
    await page.locator('[data-test="lastName"]').fill('Smith');
    await page.locator('[data-test="postalCode"]').fill('67890');
    await page.locator('[data-test="continue"]').click();
    await expect(page).toHaveURL(/checkout-step-two/);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== 'passed') {
      await page.screenshot({
        path: `test-results/screenshots/${testInfo.title.replace(/\s/g, '_')}.png`,
        fullPage: true,
      });
    }
  });

  test('payment summary shows correct item count @critical', async ({ page }) => {
    const items = page.locator('.cart_item');
    await expect(items).toHaveCount(2);
  });

  test('payment summary shows item total @critical @smoke', async ({ page }) => {
    const itemTotal = page.locator('.summary_subtotal_label');
    await expect(itemTotal).toBeVisible();
    const text = await itemTotal.textContent();
    expect(text).toContain('Item total: $');
  });

  

  test('payment summary total is correct @critical', async ({ page }) => {
    const subtotalText = await page.locator('.summary_subtotal_label').textContent();
    const taxText      = await page.locator('.summary_tax_label').textContent();
    const totalText    = await page.locator('.summary_total_label').textContent();

    const subtotal = parseFloat(subtotalText!.replace(/[^0-9.]/g, ''));
    const tax      = parseFloat(taxText!.replace(/[^0-9.]/g, ''));
    const total    = parseFloat(totalText!.replace(/[^0-9.]/g, ''));

    expect(Math.round((subtotal + tax) * 100)).toBe(Math.round(total * 100));
  });


});