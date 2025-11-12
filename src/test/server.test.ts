import request from 'supertest';
import app from '../index';

describe('Express Server', () => {
  it('should respond to health check', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('stage');
  });

  it('should respond to API root', async () => {
    const response = await request(app)
      .get('/api')
      .expect(200);
    
    expect(response.body).toHaveProperty('message', 'Capital Core API');
    expect(response.body).toHaveProperty('version', '1.0.0');
    expect(response.body).toHaveProperty('stage');
  });

  it('should return 404 for unknown routes', async () => {
    const response = await request(app)
      .get('/unknown-route')
      .expect(404);
    
    expect(response.body).toHaveProperty('error', 'Route not found');
    expect(response.body).toHaveProperty('path', '/unknown-route');
  });

  it('should have CORS headers', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.headers).toHaveProperty('access-control-allow-origin');
  });

  it('should have security headers', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
    expect(response.headers).toHaveProperty('x-frame-options', 'SAMEORIGIN');
  });
});