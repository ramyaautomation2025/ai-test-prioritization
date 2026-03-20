import { test, expect } from '@playwright/test';

test.describe('Login Module @critical', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Swag Labs/);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== 'passed') {
      await page.screenshot({
        path: `test-results/screenshots/${testInfo.title.replace(/\s/g, '_')}.png`,
        fullPage: true,
      });
    }
  });

  test('valid login with standard user @smoke @critical', async ({ page }) => {
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();

    await expect(page).toHaveURL(/inventory/);
    await expect(page.locator('.inventory_list')).toBeVisible();
    await expect(page.locator('.app_logo')).toContainText('Swag Labs');
  });

  test('invalid login shows error message @regression', async ({ page }) => {
    await page.locator('[data-test="username"]').fill('wrong_user');
    await page.locator('[data-test="password"]').fill('wrong_pass');
    await page.locator('[data-test="login-button"]').click();

    const error = page.locator('[data-test="error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Username and password do not match');
  });

  test('locked out user sees lock message @regression', async ({ page }) => {
    await page.locator('[data-test="username"]').fill('locked_out_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();

    const error = page.locator('[data-test="error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Sorry, this user has been locked out');
  });

  test('empty username shows validation error @regression', async ({ page }) => {
    await page.locator('[data-test="login-button"]').click();

    const error = page.locator('[data-test="error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Username is required');
  });

  test('empty password shows validation error @regression', async ({ page }) => {
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="login-button"]').click();

    const error = page.locator('[data-test="error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Password is required');
  });

});