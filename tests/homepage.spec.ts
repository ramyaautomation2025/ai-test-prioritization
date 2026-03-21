import { test, expect } from '@playwright/test';

test.describe('Homepage Module @smoke', () => {

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

  test('all product names are visible @smoke', async ({ page }) => {
    const names = page.locator('.inventory_item_name');
    await expect(names).toHaveCount(6);
    const firstItem = await names.first().textContent();
    expect(firstItem).toBeTruthy();
  });

  test('product listing shows prices @regression', async ({ page }) => {
    const prices = page.locator('.inventory_item_price');
    await expect(prices).toHaveCount(6);
    const firstPrice = await prices.first().textContent();
    expect(firstPrice).toContain('$');
  });

});