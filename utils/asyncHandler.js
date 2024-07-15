export const asyncHandler = (fn) => {
  return async (req, res, next) => {
    try {
      let nextCalled = false;
      let result = await fn(req, res, (params) => {
        nextCalled = true;
        next(params);
      });

      if (!res.headersSent && !nextCalled) {
        res.status(200).json(result);
      }
    } catch (error) {
      next(error);
    }
  };
};
