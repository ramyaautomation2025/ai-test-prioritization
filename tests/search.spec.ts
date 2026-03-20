import { test, expect } from '@playwright/test';

test.describe('Search & Sort Module @regression', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();
    await expect(page).toHaveURL(/inventory/);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== 'passed') {
      await page.screenshot({
        path: `test-results/screenshots/${testInfo.title.replace(/\s/g, '_')}.png`,
        fullPage: true,
      });
    }
  });

  test('sort products by price low to high @regression', async ({ page }) => {
    await page.locator('[data-test="product-sort-container"]').selectOption('lohi');
    const prices = page.locator('.inventory_item_price');
    const allPrices = await prices.allTextContents();
    const numeric = allPrices.map((p) => parseFloat(p.replace('$', '')));
    const sorted = [...numeric].sort((a, b) => a - b);
    expect(numeric).toEqual(sorted);
  });

  test('sort products by price high to low @regression', async ({ page }) => {
    await page.locator('[data-test="product-sort-container"]').selectOption('hilo');
    const prices = page.locator('.inventory_item_price');
    const allPrices = await prices.allTextContents();
    const numeric = allPrices.map((p) => parseFloat(p.replace('$', '')));
    const sorted = [...numeric].sort((a, b) => b - a);
    expect(numeric).toEqual(sorted);
  });

  test('sort products by name A to Z @regression', async ({ page }) => {
    await page.locator('[data-test="product-sort-container"]').selectOption('az');
    const names = page.locator('.inventory_item_name');
    const allNames = await names.allTextContents();
    const sorted = [...allNames].sort();
    expect(allNames).toEqual(sorted);
  });

  test('sort products by name Z to A @regression', async ({ page }) => {
    await page.locator('[data-test="product-sort-container"]').selectOption('za');
    const names = page.locator('.inventory_item_name');
    const allNames = await names.allTextContents();
    const sorted = [...allNames].sort().reverse();
    expect(allNames).toEqual(sorted);
  });

});